import type { TraceCapture } from '@mavonengine/core/Dev/trace'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import type GameServerClient from './GameServerClient'
import { mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { z } from 'zod'
import { READ_ONLY, run, vec3 } from './result'
import { analyzeTrace, toTraceEvents } from './trace'

const CLIENT_LOG_LEVELS = ['error', 'warn', 'info', 'log', 'debug'] as const
/** Severity of a console level, lower is more severe. `log` and `info` print alike */
const SEVERITY: Record<string, number> = { error: 0, warn: 1, info: 2, log: 2, debug: 3 }

const clientId = z.string().optional().describe('Tab id from list_clients. Default: the only open tab, or the only one not running the editor')

interface Vec3 { x: number, y: number, z: number }
interface Entity { id: string, position: Vec3, rotation: Vec3, scale: Vec3, serialized?: unknown, [key: string]: unknown }

function delta(a: Vec3, b: Vec3) {
  const d = { x: b.x - a.x, y: b.y - a.y, z: b.z - a.z }
  return { ...d, length: Math.hypot(d.x, d.y, d.z) }
}

/**
 * One entity on both sides: how far the client's copy is from the server's, and which serialized fields differ.
 * Transforms are compared separately and left out of the field list
 */
export function compareEntities(id: string, server: Entity | null, client: Entity | null) {
  if (!server || !client) {
    return {
      id,
      server,
      client,
      note: !server && !client
        ? 'Neither side has this entity'
        : !server
            ? 'Only the client has it: it may be client-only, or the server removed it and the client did not get SV_REMOVE_ENTITY'
            : 'Only the server has it: it may be out of this client\'s sync distance, not sent yet, or the client failed to create it',
    }
  }

  const serverFields = (server.serialized ?? {}) as Record<string, unknown>
  const clientFields = (client.serialized ?? {}) as Record<string, unknown>
  const differentFields = [...new Set([...Object.keys(serverFields), ...Object.keys(clientFields)])]
    .filter(field => !['id', 'position', 'rotation', 'scale'].includes(field))
    .filter(field => JSON.stringify(serverFields[field]) !== JSON.stringify(clientFields[field]))
    .map(field => ({ field, server: serverFields[field], client: clientFields[field] }))

  const { serialized: _s, ...serverSummary } = server
  const { serialized: _c, ...clientSummary } = client

  return {
    id,
    clientId: client.id === id ? undefined : client.id,
    positionDelta: delta(server.position, client.position),
    rotationDelta: delta(server.rotation, client.rotation),
    scaleDelta: delta(server.scale, client.scale),
    differentFields,
    server: serverSummary,
    client: clientSummary,
    note: 'Client state of remote entities is interpolated and the local player is predicted, so small deltas are expected while moving',
  }
}

/** Where client_trace saves the trace file when no path is given */
export function defaultTracePath(clientId: string, at = new Date()) {
  const stamp = at.toISOString().replace(/[:.]/g, '-')
  return join(tmpdir(), 'mavonengine-traces', `trace-${clientId}-${stamp}.json`)
}

export function registerClientTools(server: McpServer, client: GameServerClient) {
  server.registerTool('list_clients', {
    title: 'Open game tabs',
    description: 'Browser tabs running the game client in dev, connected through the dev bridge: id, page, whether it runs the editor, '
      + 'its player id on the server (playerId), visibility, focus and FPS. The other client_* tools take one of these ids.',
    annotations: READ_ONLY,
  }, () => run(async () => {
    const { clients } = await client.clients()
    return { devServer: client.clientUrl, clients, ...(clients.length ? {} : { note: 'No game tab is open. Open the game in a browser' }) }
  }))

  server.registerTool('client_status', {
    title: 'Client status',
    description: 'One tab\'s rendering and state: FPS, draw calls / triangles / points / lines of one frame, GPU geometries / textures / '
      + 'shader programs, JS heap, canvas size, camera, entity count, active scene, resource loading.',
    inputSchema: { clientId },
    annotations: READ_ONLY,
  }, ({ clientId }) => run(() => client.client('status', {}, clientId)))

  server.registerTool('client_entities', {
    title: 'Entities on a client',
    description: 'Entities in a tab\'s world, in the same shape as list_entities on the server, plus `localPlayer` for the entity the tab '
      + 'controls. Filter by type and/or distance to a point (nearest first).',
    inputSchema: {
      clientId,
      type: z.string().optional().describe('Entity class / networked type name, or scene object type, case-insensitive'),
      near: vec3.optional(),
      radius: z.number().nonnegative().optional(),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
    },
    annotations: READ_ONLY,
  }, ({ clientId, near, ...query }) => run(() => client.client('entities', { ...query, near: near && `${near.x},${near.y},${near.z}` }, clientId)))

  server.registerTool('client_entity', {
    title: 'One entity on a client',
    description: 'One entity in a tab\'s world with its serialized state. The server id of the tab\'s own player finds its local player.',
    inputSchema: { id: z.string().min(1), clientId },
    annotations: READ_ONLY,
  }, ({ id, clientId }) => run(async () => {
    const { entity } = await client.client('entity', { id }, clientId)
    if (!entity)
      throw new Error(`The client has no entity with id "${id}". client_entities shows its ids`)
    return entity
  }))

  server.registerTool('client_scene', {
    title: 'Scene on a client',
    description: 'The scene loaded in a tab, in the same shape as get_scene: objects with `built` telling whether the client built them.',
    inputSchema: { clientId, includeObjects: z.boolean().default(true) },
    annotations: READ_ONLY,
  }, ({ clientId, includeObjects }) => run(async () => {
    const { scene } = await client.client('scene', {}, clientId)
    if (!scene)
      return { scene: null, note: 'No scene is loaded in this tab. The client opens one with game.openScene(name)' }
    if (includeObjects)
      return scene
    const { objects, ...summary } = scene
    return { ...summary, objectCount: objects?.length ?? 0 }
  }))

  server.registerTool('client_network', {
    title: 'Client network state',
    description: 'A tab\'s connection to the game server: connected, player id, ping, editor mode, inputs sent but not yet acknowledged '
      + '(pendingCommands, replayed for prediction) and the next input sequence id.',
    inputSchema: { clientId },
    annotations: READ_ONLY,
  }, ({ clientId }) => run(() => client.client('network', {}, clientId)))

  server.registerTool('client_logs', {
    title: 'Client console',
    description: 'A tab\'s console output, uncaught errors and unhandled promise rejections since it loaded (the last 500), oldest first. '
      + 'Pass the returned latestId as afterId later to get only newer lines.',
    inputSchema: {
      clientId,
      level: z.enum(CLIENT_LOG_LEVELS).optional().describe('Only this level and more severe ones, e.g. warn includes error'),
      contains: z.string().optional().describe('Only lines containing this text, case-insensitive'),
      afterId: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100).describe('Newest lines kept when more match'),
    },
    annotations: READ_ONLY,
  }, ({ clientId, level, contains, afterId, limit }) => run(async () => {
    const { entries = [], latestId = 0 } = await client.client('logs', { after: afterId }, clientId)
    const maxSeverity = level ? SEVERITY[level]! : Infinity
    const needle = contains?.toLowerCase()

    const matches = (entries as { id: number, timestamp: number, level: string, message: string }[])
      .filter(entry => (SEVERITY[entry.level] ?? 2) <= maxSeverity && (!needle || entry.message.toLowerCase().includes(needle)))

    return {
      latestId,
      matched: matches.length,
      entries: matches.slice(-limit).map(({ timestamp, ...entry }) => ({ ...entry, time: new Date(timestamp).toISOString() })),
    }
  }))

  server.registerTool('client_screenshot', {
    title: 'Client screenshot',
    description: 'What a tab renders right now, as an image. Only the WebGL canvas: HTML UI drawn over it is not included.',
    inputSchema: {
      clientId,
      maxWidth: z.number().int().min(64).max(4096).default(1024).describe('Scaled down to this width'),
      format: z.enum(['jpeg', 'png']).default('jpeg'),
    },
    annotations: READ_ONLY,
  }, async ({ clientId, maxWidth, format }): Promise<CallToolResult> => {
    try {
      const shot = await client.client('screenshot', { maxWidth, format }, clientId)
      return {
        content: [
          { type: 'image', data: shot.data, mimeType: shot.mimeType },
          { type: 'text', text: `${shot.width}x${shot.height} ${shot.mimeType}` },
        ],
      }
    }
    catch (err) {
      return { isError: true, content: [{ type: 'text', text: (err as Error).message }] }
    }
  })

  server.registerTool('client_trace', {
    title: 'Trace client rendering',
    description: 'Record a tab for a few seconds and analyse its performance: frame time distribution, render CPU vs GPU time per '
      + 'frame, time per composer pass, game tick time (physics, world.update), WebGL work per frame (draw calls, program / texture / '
      + 'framebuffer switches, uniform calls, uploads), the bottleneck, and the worst hitches with their likely causes (shader '
      + 'compiles, texture uploads, GPU syncs, GC, slow ticks, long scripts, hot JS functions). JS sampling uses the browser\'s JS '
      + 'Self-Profiling API (Chromium) and GPU time EXT_disjoint_timer_query_webgl2. Also saves a Chrome Trace Event file to open '
      + 'as a flame chart in https://ui.perfetto.dev or chrome://tracing. Keep the tab in the foreground while it records.',
    inputSchema: {
      clientId,
      durationMs: z.number().int().min(500).max(15000).default(3000).describe('How long to record'),
      jsProfile: z.boolean().default(true).describe('Sample JS call stacks'),
      sampleIntervalMs: z.number().int().min(1).max(100).default(10).describe('JS sampling interval, the browser may round it up'),
      gpu: z.boolean().default(true).describe('Time each frame on the GPU'),
      maxHitches: z.number().int().min(0).max(50).default(10).describe('Worst late frames to explain'),
      savePath: z.string().optional().describe('Where to write the trace file. Default: a file in the system temp directory'),
      save: z.boolean().default(true).describe('Write the trace file'),
    },
    annotations: { ...READ_ONLY, idempotentHint: false },
  }, ({ clientId, durationMs, jsProfile, sampleIntervalMs, gpu, maxHitches, savePath, save }) => run(async () => {
    const capture = await client.client('trace', { durationMs, jsProfile: String(jsProfile), sampleIntervalMs, gpu: String(gpu) }, clientId) as TraceCapture
    const analysis = analyzeTrace(capture, { maxHitches })

    let traceFile: string | undefined
    if (save) {
      traceFile = savePath ? resolve(savePath) : defaultTracePath(clientId ?? 'auto')
      await mkdir(dirname(traceFile), { recursive: true })
      await writeFile(traceFile, JSON.stringify(toTraceEvents(capture)))
    }

    return {
      ...analysis,
      traceFile,
      traceFileNote: traceFile ? 'Chrome Trace Event JSON: drag it into https://ui.perfetto.dev (or chrome://tracing, or speedscope.app) for the flame chart' : undefined,
    }
  }))

  server.registerTool('compare_entity', {
    title: 'Compare an entity on server and client',
    description: 'One entity as the server has it next to a tab\'s copy: position / rotation / scale deltas and the serialized fields that '
      + 'differ. For the tab\'s own player pass its server id (playerId from list_clients). Needs the server in development too.',
    inputSchema: { id: z.string().min(1).describe('Entity id on the server'), clientId },
    annotations: READ_ONLY,
  }, ({ id, clientId }) => run(async () => {
    const [onServer, onClient] = await Promise.all([client.entity(id), client.client('entity', { id }, clientId)])
    return compareEntities(id, onServer.entity, onClient.entity)
  }))
}
