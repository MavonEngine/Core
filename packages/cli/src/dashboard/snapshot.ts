import type { HttpRouteInfo } from '@mavonengine/core/Networking/Server/Http/RouteInfo'
import type { LogEntry } from '@mavonengine/core/Networking/Server/Stats/LogBuffer'
import type { RequestLogEntry } from '@mavonengine/core/Networking/Server/Stats/RequestLog'
import type { ServerMetricsSnapshot } from '@mavonengine/core/Networking/Server/Stats/ServerMetrics'

export type { ServerMetricsSnapshot }
export type LogLine = LogEntry
export type RequestLine = RequestLogEntry
export type RouteLine = HttpRouteInfo

/** One packet or network event the server recorded (GET /api/game/dev/net/packets) */
export interface PacketLine {
  id: number
  timestamp: number
  kind: 'packet' | 'event'
  /** Seen from the server: `out` was sent to the client, `in` came from it. Null for events */
  direction: 'in' | 'out' | null
  /** Message name on the wire, or the event's name */
  type: string
  /** Channel id of the client, which is its player id */
  peer: string | null
  bytes: number
  tick: number | null
  sequenceId: number | null
  reliable: boolean
  /** Short facts about the payload, e.g. `{ entities: 12, ack: 40 }` */
  info: Record<string, unknown>
}

/** The content of one packet or event, for the details panel of the Network tab */
export interface PacketDetail {
  id: number
  /** `gone`: the server no longer keeps the record or its payload. `empty`: it never had one, like a ping */
  status: 'loading' | 'loaded' | 'gone' | 'empty' | 'error'
  /** The payload as indented JSON, one line each. For an event, its details */
  lines: string[]
  error?: string
}

/** The server's state sync (GET /api/game/dev/net/sync), without the per-entity list */
export interface SyncInfo {
  tick: number
  tickRate: number
  syncDistance: number | null
  /** Entities the server syncs */
  entities: number
  /** Synced entities no player is in range of, players themselves not counted */
  untracked: number
  editors: number
  players: SyncPlayerLine[]
}

export interface SyncPlayerLine {
  id: string
  displayName: string
  /** Entities in its last state update */
  tracked: number
  /** Sequence id of its last input the server processed */
  ack: number
  lastState: { tick: number, bytes: number, entities: number } | null
}

/**
 * The newest metrics schema this CLI understands.
 */
export const SUPPORTED_SCHEMA_VERSION = 1

type AnyRecord = Record<string, any>

function isRecord(value: unknown): value is AnyRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function num(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function str(value: unknown, fallback = ''): string {
  return typeof value === 'string' ? value : fallback
}

function numOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function strOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null
}

function arr<T>(value: unknown, map: (item: AnyRecord) => T): T[] {
  return Array.isArray(value) ? value.filter(isRecord).map(map) : []
}

function section(value: unknown): AnyRecord {
  return isRecord(value) ? value : {}
}

function tickSample(t: AnyRecord) {
  return {
    timestamp: num(t.timestamp),
    ticks: num(t.ticks),
    ticksPerSecond: num(t.ticksPerSecond),
    avgMs: num(t.avgMs),
    maxMs: num(t.maxMs),
    commandsPerSecond: num(t.commandsPerSecond),
    maxCommandsPerTick: num(t.maxCommandsPerTick),
  }
}

/**
 * Turn whatever a server returned into a complete snapshot.
 *
 * The CLI and the server are released separately, so a field can be missing
 * (older server) or unknown (newer server). Missing fields fall back to empty
 * values so the dashboard keeps rendering instead of crashing.
 */
export function normalizeSnapshot(raw: unknown): ServerMetricsSnapshot {
  const s = section(raw)
  const world = section(s.world)
  const cpu = section(s.cpu)
  const bandwidth = section(s.bandwidth)
  const tick = section(s.tick)
  const memory = section(s.memory)
  const physics = isRecord(s.physics) ? s.physics : null
  const latency = isRecord(s.latencySimulation) ? s.latencySimulation : null

  return {
    schemaVersion: num(s.schemaVersion, SUPPORTED_SCHEMA_VERSION) as typeof SUPPORTED_SCHEMA_VERSION,
    engineVersion: str(s.engineVersion, 'unknown'),
    serverTime: str(s.serverTime),
    uptime: num(s.uptime),
    sampleIntervalMs: num(s.sampleIntervalMs, 1000) || 1000,
    tickRate: num(s.tickRate),
    players: arr(s.players, (p) => {
      const position = section(p.position)
      const connection = isRecord(p.connection) ? p.connection : null
      const id = str(p.id, '?')
      return {
        id,
        // Older servers don't send a name
        displayName: str(p.displayName, id),
        position: { x: num(position.x), y: num(position.y), z: num(position.z) },
        lastProcessedSequenceId: num(p.lastProcessedSequenceId),
        trackedEntities: num(p.trackedEntities),
        connectedFor: num(p.connectedFor),
        connection: connection
          ? {
              address: strOrNull(connection.address),
              rttMs: numOrNull(connection.rttMs),
              bytesSent: num(connection.bytesSent),
              bytesReceived: num(connection.bytesReceived),
            }
          : null,
      }
    }),
    world: {
      entities: num(world.entities),
    },
    physics: physics
      ? { bodies: num(physics.bodies), colliders: num(physics.colliders) }
      : null,
    cpu: {
      current: num(cpu.current),
      avg1s: num(cpu.avg1s),
      avg10s: num(cpu.avg10s),
      avg60s: num(cpu.avg60s),
      history: arr(cpu.history, h => ({ timestamp: num(h.timestamp), cpuPercentage: num(h.cpuPercentage) })),
    },
    bandwidth: {
      sentPerSecond: num(bandwidth.sentPerSecond),
      receivedPerSecond: num(bandwidth.receivedPerSecond),
      history: arr(bandwidth.history, b => ({ timestamp: num(b.timestamp), sent: num(b.sent), received: num(b.received) })),
    },
    tick: {
      budgetMs: num(tick.budgetMs),
      latest: isRecord(tick.latest) ? tickSample(tick.latest) : null,
      history: arr(tick.history, tickSample),
    },
    memory: {
      rss: num(memory.rss),
      heapUsed: num(memory.heapUsed),
      heapTotal: num(memory.heapTotal),
      external: num(memory.external),
    },
    latencySimulation: latency
      ? { fixedLatency: num(latency.fixedLatency), jitter: num(latency.jitter), packetLoss: num(latency.packetLoss) }
      : null,
  }
}

/**
 * Same as normalizeSnapshot, for a GET /api/game/logs response.
 */
export function normalizeLogs(raw: unknown): { entries: LogLine[], latestId: number } {
  const r = section(raw)
  const entries = arr(r.entries, e => ({
    id: num(e.id),
    timestamp: num(e.timestamp),
    level: str(e.level, 'info'),
    message: str(e.message),
  }))

  return {
    entries,
    latestId: num(r.latestId, entries.at(-1)?.id ?? 0),
  }
}

/**
 * Same as normalizeSnapshot, for a GET /api/game/requests response.
 */
export function normalizeRequests(raw: unknown): { entries: RequestLine[], latestId: number } {
  const r = section(raw)
  const entries = arr(r.entries, e => ({
    id: num(e.id),
    timestamp: num(e.timestamp),
    method: str(e.method, '?'),
    path: str(e.path),
    status: numOrNull(e.status),
    durationMs: num(e.durationMs),
    bytes: num(e.bytes),
    address: strOrNull(e.address),
  }))

  return {
    entries,
    latestId: num(r.latestId, entries.at(-1)?.id ?? 0),
  }
}

/**
 * Same as normalizeSnapshot, for a GET /api/game/dev/net/packets response.
 */
export function normalizePackets(raw: unknown): { entries: PacketLine[], latestId: number } {
  const r = section(raw)
  const entries = arr(r.records, (e): PacketLine => ({
    id: num(e.id),
    timestamp: num(e.timestamp),
    kind: e.kind === 'event' ? 'event' : 'packet',
    direction: e.direction === 'in' || e.direction === 'out' ? e.direction : null,
    type: str(e.type, '?'),
    peer: strOrNull(e.peer),
    bytes: num(e.bytes),
    tick: numOrNull(e.tick),
    sequenceId: numOrNull(e.sequenceId),
    reliable: e.reliable === true,
    info: section(e.info),
  }))

  return {
    entries,
    latestId: num(r.latestId, entries.at(-1)?.id ?? 0),
  }
}

/**
 * Same as normalizeSnapshot, for a GET /api/game/dev/net/sync response.
 */
export function normalizeSync(raw: unknown): SyncInfo {
  const r = section(raw)
  const players = arr(r.players, (p): SyncPlayerLine => {
    const lastState = isRecord(p.lastState) ? p.lastState : null
    return {
      id: str(p.id),
      displayName: str(p.displayName, str(p.id)),
      tracked: Array.isArray(p.tracked) ? p.tracked.length : 0,
      ack: num(p.ack),
      lastState: lastState && { tick: num(lastState.tick), bytes: num(lastState.bytes), entities: num(lastState.entities) },
    }
  })
  const entities = arr(r.entities, e => ({ player: e.player === true, trackedBy: num(e.trackedBy) }))

  return {
    tick: num(r.tick),
    tickRate: num(r.tickRate),
    syncDistance: numOrNull(r.syncDistance),
    entities: entities.length,
    // Without players nothing is tracked, which says nothing about the entities
    untracked: players.length ? entities.filter(e => !e.player && e.trackedBy === 0).length : 0,
    editors: Array.isArray(r.editors) ? r.editors.length : 0,
    players,
  }
}

/**
 * A GET /api/game/dev/net/packets/:id response as the lines the details panel shows.
 */
export function normalizePacketDetail(id: number, raw: unknown): PacketDetail {
  const record = section(raw).record
  if (!isRecord(record))
    return { id, status: 'gone', lines: [] }

  const lines = (value: unknown) => JSON.stringify(value, null, 2).split('\n')

  if (record.payload !== undefined && record.payload !== null)
    return { id, status: 'loaded', lines: lines(record.payload) }
  // An event has no payload: what it says is in its info
  if (record.kind === 'event' && isRecord(record.info))
    return { id, status: 'loaded', lines: lines(record.info) }
  // It had a payload once, dropped since to bound the server's memory
  if (record.kind !== 'event' && num(record.bytes) > 0)
    return { id, status: 'gone', lines: [] }

  return { id, status: 'empty', lines: [] }
}

function descriptions(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value))
    return undefined

  return Object.fromEntries(Object.entries(value).map(([name, description]) => [name, str(description)]))
}

/**
 * Same as normalizeSnapshot, for a GET /api/game/routes response.
 */
export function normalizeRoutes(raw: unknown): RouteLine[] {
  return arr(section(raw).routes, (r) => {
    const source = r.source === 'engine' || r.source === 'plugin' ? r.source : 'game'
    const plugin = strOrNull(r.plugin)
    const query = descriptions(r.query)

    return {
      method: str(r.method, '?'),
      path: str(r.path),
      source,
      ...(plugin ? { plugin } : {}),
      params: descriptions(r.params) ?? {},
      devOnly: r.devOnly === true,
      ...(query ? { query } : {}),
      ...Object.fromEntries((['summary', 'description', 'response', 'auth'] as const)
        .filter(key => typeof r[key] === 'string')
        .map(key => [key, r[key] as string])),
    }
  })
}
