import type { DocsClient } from './docs'
import type GameServerClient from './GameServerClient'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { version } from '../../package.json'
import { registerClientTools } from './clientTools'
import { registerDocsTools } from './docs'
import { LOG_LEVELS, READ_ONLY, run, vec3 } from './result'

const INSTRUCTIONS = `Reads the live state of a running MavonEngine game: the game server (health, performance, players, scene,
entities, logs, HTTP requests) and, in development, the game tabs open in a browser (renderer stats, the client's world,
network state, console logs, screenshots). Every tool is read-only.
Server scene / entity tools need the server in development (NODE_ENV is not "production"); client tools need the client
served by Vite in dev. Start with server_status and list_clients. Use type / near filters rather than paging through a world.
compare_entity shows one entity on both sides, for prediction, interpolation and sync bugs.
docs_list_pages / docs_get_page read the MavonEngine documentation: check it before guessing how an engine API works.`

/** The metrics snapshot without its per-second history arrays */
function summarize(metrics: any) {
  const { cpu, bandwidth, tick, players, ...rest } = metrics ?? {}
  return {
    ...rest,
    players: Array.isArray(players) ? players.length : 0,
    cpu: cpu && { current: cpu.current, avg1s: cpu.avg1s, avg10s: cpu.avg10s, avg60s: cpu.avg60s },
    bandwidth: bandwidth && { sentPerSecond: bandwidth.sentPerSecond, receivedPerSecond: bandwidth.receivedPerSecond },
    tick: tick && { budgetMs: tick.budgetMs, latest: tick.latest },
  }
}

/** Level name with any formatting left over, e.g. `info` from `[info]` */
function levelOf(level: string) {
  return level.toLowerCase().replace(/[^a-z]/g, '')
}

/**
 * The MCP server with the game server and client tools, and the docs_* tools when `docs` is given (left out with `--no-docs`)
 */
export function createMcpServer(client: GameServerClient, docs?: DocsClient): McpServer {
  const server = new McpServer({ name: 'mavonengine', version }, { instructions: INSTRUCTIONS })

  server.registerTool('server_status', {
    title: 'Game server status',
    description: 'Health and current performance of the game server: uptime, tick rate and tick time against its budget, CPU, '
      + 'bandwidth, memory, player and entity counts, physics bodies, latency simulation. History is left out, see server_metrics.',
    annotations: READ_ONLY,
  }, () => run(async () => ({ server: client.url, ...summarize(await client.metrics()) })))

  server.registerTool('server_metrics', {
    title: 'Full metrics snapshot',
    description: 'The full metrics snapshot. With includeHistory, also the last ~60 samples of CPU, bandwidth and tick timings, to spot spikes.',
    inputSchema: { includeHistory: z.boolean().default(false).describe('Include the per-sample history arrays') },
    annotations: READ_ONLY,
  }, ({ includeHistory }) => run(async () => {
    const metrics = await client.metrics()
    if (includeHistory)
      return metrics
    const { cpu, bandwidth, tick } = metrics ?? {}
    const { history: _cpu, ...cpuNow } = cpu ?? {}
    const { history: _bandwidth, ...bandwidthNow } = bandwidth ?? {}
    const { history: _tick, ...tickNow } = tick ?? {}
    return { ...metrics, cpu: cpuNow, bandwidth: bandwidthNow, tick: tickNow }
  }))

  server.registerTool('list_players', {
    title: 'Connected players',
    description: 'Connected players: id, display name, position, last processed input sequence, tracked entities, time connected, '
      + 'and connection details (address, round trip time, bytes sent and received).',
    annotations: READ_ONLY,
  }, () => run(async () => (await client.metrics())?.players ?? []))

  server.registerTool('get_scene', {
    title: 'Active scene',
    description: 'The scene loaded on the server: name, file, whether it hot-reloads, unsaved changes, settings, and its objects '
      + 'with type, transform, props, the plugin that registered the type and whether the server built it (false for client-only types). '
      + 'Development only.',
    inputSchema: { includeObjects: z.boolean().default(true).describe('Include the scene objects, not just the summary') },
    annotations: READ_ONLY,
  }, ({ includeObjects }) => run(async () => {
    const { scene } = await client.scene()
    if (!scene)
      return { scene: null, note: 'No scene is loaded. The server opens one with server.openScene(name)' }
    if (includeObjects)
      return scene
    const { objects, ...summary } = scene
    return { ...summary, objectCount: objects?.length ?? 0 }
  }))

  server.registerTool('list_entities', {
    title: 'Entities in the world',
    description: 'Entities in the server world: id, type, position, rotation, scale, whether networked or a player, and the scene object '
      + 'it was built from. Filter by type and/or distance to a point (results are then nearest first). Returns the total match count. '
      + 'Development only.',
    inputSchema: {
      type: z.string().optional().describe('Entity class / networked type name, or scene object type, case-insensitive'),
      near: vec3.optional().describe('Only entities around this point, nearest first'),
      radius: z.number().nonnegative().optional().describe('Max distance from `near`'),
      limit: z.number().int().min(1).max(500).default(50),
      offset: z.number().int().min(0).default(0),
    },
    annotations: READ_ONLY,
  }, query => run(() => client.entities(query)))

  server.registerTool('get_entity', {
    title: 'One entity',
    description: 'One entity by id, with the state it sends to clients (its serialize() output). Development only.',
    inputSchema: { id: z.string().min(1) },
    annotations: READ_ONLY,
  }, ({ id }) => run(async () => {
    const { entity } = await client.entity(id)
    if (!entity)
      throw new Error(`No entity with id "${id}" in the world. list_entities shows the ids`)
    return entity
  }))

  server.registerTool('recent_logs', {
    title: 'Server logs',
    description: 'Recent game server log lines, oldest first. The server keeps the last 500 by default. '
      + 'Pass the returned latestId as afterId later to get only newer lines.',
    inputSchema: {
      level: z.enum(LOG_LEVELS).optional().describe('Only this level and more severe ones, e.g. warn includes error'),
      contains: z.string().optional().describe('Only lines containing this text, case-insensitive'),
      afterId: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(100).describe('Newest lines kept when more match'),
    },
    annotations: READ_ONLY,
  }, ({ level, contains, afterId, limit }) => run(async () => {
    const { entries = [], latestId = 0 } = await client.logs(afterId)
    const maxSeverity = level ? LOG_LEVELS.indexOf(level) : Infinity
    const needle = contains?.toLowerCase()

    const matches = (entries as { id: number, timestamp: number, level: string, message: string }[]).filter((entry) => {
      const severity = LOG_LEVELS.indexOf(levelOf(entry.level) as typeof LOG_LEVELS[number])
      return (severity === -1 || severity <= maxSeverity) && (!needle || entry.message.toLowerCase().includes(needle))
    })

    return {
      latestId,
      matched: matches.length,
      entries: matches.slice(-limit).map(({ timestamp, ...entry }) => ({ ...entry, time: new Date(timestamp).toISOString() })),
    }
  }))

  server.registerTool('recent_requests', {
    title: 'HTTP requests',
    description: 'Recent HTTP requests the game server answered: method, path, status, duration, bytes, address. '
      + 'Pass the returned latestId as afterId later to get only newer ones.',
    inputSchema: {
      pathContains: z.string().optional(),
      minStatus: z.number().int().optional().describe('e.g. 400 for errors only'),
      afterId: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(500).default(50).describe('Newest requests kept when more match'),
    },
    annotations: READ_ONLY,
  }, ({ pathContains, minStatus, afterId, limit }) => run(async () => {
    const { entries = [], latestId = 0 } = await client.requests(afterId)
    const matches = (entries as { path: string, status: number | null }[]).filter(entry =>
      (!pathContains || entry.path.includes(pathContains))
      && (minStatus === undefined || (entry.status ?? 0) >= minStatus))

    return { latestId, matched: matches.length, entries: matches.slice(-limit) }
  }))

  registerClientTools(server, client)
  if (docs)
    registerDocsTools(server, docs)

  return server
}
