import type Game from '../Game'
import type GameObject from '../World/GameObject'
import type { BridgeClientInfo, BridgeQuery, BridgeRequest, BridgeResponse } from './bridgeProtocol'
import type { EntitySummary } from './inspect'
import { parseNetRecordQuery, setNetDebugDefault } from '../Networking/Debug/NetRecorder'
import { BRIDGE_ANNOUNCE, BRIDGE_HELLO, BRIDGE_QUERIES, BRIDGE_REQUEST, BRIDGE_RESPONSE, traceDuration } from './bridgeProtocol'
import { describeScene, detailEntity, parseEntityQuery, queryEntities, summarizeEntity, vec } from './inspect'
import { recordTrace } from './trace'

/**
 * The part of Vite's `import.meta.hot` the bridge uses. Passed in by the virtual module the Vite plugin injects,
 * because `import.meta.hot` only exists in modules Vite transforms itself, and core may be pre-bundled.
 */
export interface HotChannel {
  send(event: string, data?: unknown): void
  on(event: string, cb: (data: any) => void): void
}

export interface ClientLogEntry {
  id: number
  timestamp: number
  level: 'log' | 'info' | 'warn' | 'error' | 'debug'
  message: string
}

export interface ClientEntitySummary extends EntitySummary {
  /** The entity this tab controls, marked with `isLocalPlayer = true`. Its id may differ from the server's */
  localPlayer: boolean
}

const MAX_LOG_ENTRIES = 500
const MAX_MESSAGE_LENGTH = 4000
const CLIENT_ID_KEY = 'mavonengine:bridge:id'
const FORMAT_RE = /%[csdifoO]/g

const logs: ClientLogEntry[] = []
let nextLogId = 1
let started = false

/**
 * Answer the dev server's questions about this tab: renderer, world, scene, network, logs and screenshots.
 * Does nothing outside the browser or when called twice.
 */
export function startDevBridge(hot: HotChannel) {
  if (started || typeof window === 'undefined')
    return
  started = true

  captureConsole()

  // Record the traffic of the game connection, whether it exists yet or not
  setNetDebugDefault(true)
  if (window.Game?.network?.net)
    window.Game.network.net.enabled = true

  const hello = () => hot.send(BRIDGE_HELLO, info())
  hot.on(BRIDGE_ANNOUNCE, hello)
  hot.on('vite:ws:connect', hello)
  hello()

  hot.on(BRIDGE_REQUEST, (request: BridgeRequest) => {
    void answer(request).then(response => hot.send(BRIDGE_RESPONSE, response))
  })
}

function game(): Game {
  const current = window.Game
  if (!current)
    throw new Error('No game is running in this tab yet (window.Game is not set)')
  return current
}

function clientId(): string {
  try {
    let id = sessionStorage.getItem(CLIENT_ID_KEY)
    if (!id) {
      id = Math.random().toString(36).slice(2, 10)
      sessionStorage.setItem(CLIENT_ID_KEY, id)
    }
    return id
  }
  catch {
    return (window as { __mavonBridgeId?: string }).__mavonBridgeId ??= Math.random().toString(36).slice(2, 10)
  }
}

export function info(): BridgeClientInfo {
  const current = window.Game
  return {
    id: clientId(),
    url: location.href,
    title: document.title,
    userAgent: navigator.userAgent,
    playerId: current?.network?.socket.id ?? null,
    editor: !!current?.editor,
    visible: document.visibilityState === 'visible',
    focused: document.hasFocus(),
    fps: current ? Math.round(current.renderer.fps) : null,
  }
}

const isPlayer = (entity: GameObject) => typeof (entity as { isLocalPlayer?: unknown }).isLocalPlayer === 'boolean'
const isLocalPlayer = (entity: GameObject) => (entity as { isLocalPlayer?: unknown }).isLocalPlayer === true || window.Game?.localPlayer === entity

function summarize(entity: GameObject): ClientEntitySummary {
  return { ...summarizeEntity(entity, game().activeScene, isPlayer), localPlayer: isLocalPlayer(entity) }
}

/**
 * The entity this tab controls: `game.localPlayer` when the game sets it, otherwise one marked `isLocalPlayer`,
 * in the world or held by an entity in it (e.g. a player controller)
 */
function localPlayer(): GameObject | undefined {
  const current = game()
  if (current.localPlayer)
    return current.localPlayer

  for (const entity of current.world.entities.items.values()) {
    if (isLocalPlayer(entity))
      return entity
    for (const value of Object.values(entity)) {
      if (value && typeof value === 'object' && 'position' in value && isLocalPlayer(value as GameObject))
        return value as GameObject
    }
  }
  return undefined
}

/** The world's entities, plus the local player when it isn't in the world itself */
function entities(): GameObject[] {
  const list = [...game().world.entities.items.values()]
  const local = localPlayer()
  if (local && !list.includes(local))
    list.push(local)
  return list
}

/**
 * The entity with this id. The server keys a player by its socket id, while the client may key its own player
 * differently, so this tab's player id finds the local player.
 */
function findEntity(id: string): GameObject | undefined {
  const { network, world } = game()
  const entity = world.entities.items.get(id) ?? entities().find(e => e.id === id)
  if (entity)
    return entity
  if (network?.socket.id && id === network.socket.id)
    return localPlayer()
  return undefined
}

/**
 * Resolves after the next rendered frame, or after `timeoutMs` when the tab doesn't render (e.g. hidden).
 * The game queues its next render before this callback is queued, so when this runs a whole frame has rendered
 */
function nextFrame(timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs, false)
    requestAnimationFrame(() => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

const QUERIES: Record<BridgeQuery, (params: Record<string, string>) => unknown> = {
  info,

  async status() {
    const current = game()
    const renderer = current.renderer.instance

    // The composer renders several passes per frame and renderer.info resets on each, so count one whole frame
    renderer.info.autoReset = false
    renderer.info.reset()
    // Ends as soon as a frame rendered, so the limit only matters for a tab that renders slowly or not at all (hidden)
    const waitMs = document.visibilityState === 'visible' ? 4000 : 500
    const measured = await nextFrame(waitMs)
    const { render, memory, programs } = renderer.info
    const frame = { calls: render.calls, triangles: render.triangles, points: render.points, lines: render.lines }
    renderer.info.autoReset = true

    const heap = (performance as { memory?: { usedJSHeapSize: number, totalJSHeapSize: number, jsHeapSizeLimit: number } }).memory
    const camera = current.camera.instance as { position: { x: number, y: number, z: number }, rotation: { x: number, y: number, z: number }, fov?: number, near?: number, far?: number }

    return {
      ...info(),
      tickRate: current.tickRate,
      frame: measured ? frame : null,
      frameNote: measured
        ? undefined
        : document.visibilityState === 'visible'
          ? `No frame was rendered within ${Math.round(waitMs)}ms`
          : 'The tab is in the background, so the browser does not render it',
      gpuMemory: { geometries: memory.geometries, textures: memory.textures, programs: programs?.length ?? 0 },
      jsHeap: heap ? { used: heap.usedJSHeapSize, total: heap.totalJSHeapSize, limit: heap.jsHeapSizeLimit } : null,
      canvas: { width: current.canvas.width, height: current.canvas.height, pixelRatio: renderer.getPixelRatio() },
      camera: { position: vec(camera.position), rotation: vec(camera.rotation), fov: camera.fov, near: camera.near, far: camera.far },
      entities: current.world.entities.length,
      scene: current.activeScene?.name ?? null,
      resources: { loaded: current.resources.loaded, toLoad: current.resources.toLoad },
    }
  },

  entities(params) {
    const query = parseEntityQuery(params)
    if (typeof query === 'string')
      throw new Error(query)
    return queryEntities(entities().map(summarize), query)
  },

  entity({ id }) {
    if (!id)
      throw new Error('id is required')
    const entity = findEntity(id)
    if (!entity)
      return { entity: null }
    return { entity: { ...detailEntity(entity, game().activeScene, isPlayer), localPlayer: isLocalPlayer(entity) } }
  },

  scene() {
    const scene = game().activeScene
    return { scene: scene ? describeScene(scene) : null }
  },

  network() {
    const network = game().network
    if (!network)
      return { network: null, note: 'This tab has no NetworkManager: it is not connected to a game server' }

    const internals = network as unknown as { localCommandQueue?: unknown[], currentSequenceId?: number }
    return {
      network: {
        connected: network.connected,
        playerId: network.socket.id ?? null,
        pingMs: network.ping,
        editorMode: network.editorMode,
        /** Inputs sent but not yet acknowledged by the server, replayed for prediction */
        pendingCommands: internals.localCommandQueue?.length ?? null,
        nextSequenceId: internals.currentSequenceId ?? null,
        /** The last state update: its server tick, the last input it acknowledges, how long ago it arrived */
        lastState: network.serverView && {
          tick: network.serverView.tick,
          serverTime: network.serverView.serverTime,
          ack: network.serverView.ack,
          ageMs: network.serverView.receivedAt === null ? null : Math.round(performance.now() - network.serverView.receivedAt),
          missedStates: network.serverView.missedStates,
        },
        recording: network.net?.enabled ?? false,
      },
    }
  },

  packets(params) {
    const query = parseNetRecordQuery(params)
    if (typeof query === 'string')
      throw new Error(query)
    const net = game().network?.net
    if (!net)
      throw new Error('This tab has no NetworkManager: it is not connected to a game server')
    return net.list(query)
  },

  packet({ id }) {
    const net = game().network?.net
    if (!net)
      throw new Error('This tab has no NetworkManager: it is not connected to a game server')
    return { record: net.get(Number(id)) ?? null }
  },

  logs({ after }) {
    const afterId = Number(after ?? 0) || 0
    return { entries: logs.filter(entry => entry.id > afterId), latestId: nextLogId - 1 }
  },

  async screenshot({ maxWidth, format }) {
    const current = game()
    const width = Math.max(64, Math.min(Number(maxWidth) || 1024, 4096))
    const mimeType = format === 'png' ? 'image/png' : 'image/jpeg'

    // Without preserveDrawingBuffer the canvas is cleared after each frame: render one now and copy it in the same task
    current.renderer.composer.render()
    const source = current.canvas
    const scale = Math.min(1, width / source.width)
    const copy = document.createElement('canvas')
    copy.width = Math.max(1, Math.round(source.width * scale))
    copy.height = Math.max(1, Math.round(source.height * scale))
    copy.getContext('2d')!.drawImage(source, 0, 0, copy.width, copy.height)

    const dataUrl = copy.toDataURL(mimeType, 0.85)
    return { mimeType, width: copy.width, height: copy.height, data: dataUrl.slice(dataUrl.indexOf(',') + 1) }
  },

  trace({ durationMs, gpu, jsProfile, sampleIntervalMs }) {
    return recordTrace(game(), {
      durationMs: traceDuration(durationMs),
      gpu: gpu !== 'false',
      jsProfile: jsProfile !== 'false',
      sampleIntervalMs: Math.max(1, Math.min(Number(sampleIntervalMs) || 10, 100)),
    })
  },
}

export async function answer({ requestId, query, params }: BridgeRequest): Promise<BridgeResponse> {
  try {
    if (!BRIDGE_QUERIES.includes(query))
      throw new Error(`Unknown query ${query}`)
    return { requestId, ok: true, data: await QUERIES[query](params ?? {}) }
  }
  catch (err) {
    return { requestId, ok: false, error: (err as Error).message }
  }
}

/**
 * Keep the console output and uncaught errors of the tab. The console still prints as usual
 */
function captureConsole() {
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    // eslint-disable-next-line no-console
    const original = console[level].bind(console)
    // eslint-disable-next-line no-console
    console[level] = (...args: unknown[]) => {
      pushLog(level, formatArgs(args))
      original(...args)
    }
  }

  window.addEventListener('error', (event) => {
    pushLog('error', `Uncaught ${event.error instanceof Error ? (event.error.stack ?? event.error.message) : event.message}`)
  })
  window.addEventListener('unhandledrejection', (event) => {
    const reason = event.reason
    pushLog('error', `Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : formatArgs([reason])}`)
  })
}

export function pushLog(level: ClientLogEntry['level'], message: string, now = Date.now()) {
  logs.push({ id: nextLogId++, timestamp: now, level, message: message.length > MAX_MESSAGE_LENGTH ? `${message.slice(0, MAX_MESSAGE_LENGTH)}…` : message })
  if (logs.length > MAX_LOG_ENTRIES)
    logs.splice(0, logs.length - MAX_LOG_ENTRIES)
}

/**
 * Console arguments as one line of text. `%c` styles (the engine's Logger uses them) are dropped with their CSS argument
 */
export function formatArgs(args: unknown[]): string {
  const rest = [...args]
  let message = ''

  if (typeof rest[0] === 'string') {
    // Directives take the arguments after the format left to right; %c takes a CSS string, which is dropped
    message = (rest.shift() as string).replace(FORMAT_RE, (directive) => {
      if (!rest.length)
        return directive === '%c' ? '' : directive
      const value = rest.shift()
      return directive === '%c' ? '' : stringify(value)
    }).trim()
  }

  return [message, ...rest.map(stringify)].filter(Boolean).join(' ')
}

function stringify(value: unknown): string {
  if (typeof value === 'string')
    return value
  if (value instanceof Error)
    return value.stack ?? `${value.name}: ${value.message}`
  if (typeof value !== 'object' || value === null)
    return String(value)

  const seen = new WeakSet()
  try {
    return JSON.stringify(value, (_key, v: unknown) => {
      if (typeof v === 'object' && v !== null) {
        if (seen.has(v))
          return '[Circular]'
        seen.add(v)
      }
      return v
    }) ?? String(value)
  }
  catch {
    return String(value)
  }
}

/** For tests: forget the captured log entries */
export function resetDevBridgeLogs() {
  logs.length = 0
  nextLogId = 1
}
