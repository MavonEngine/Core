import type { LogEntry } from '@mavonengine/core/Networking/Server/Stats/LogBuffer'
import type { RequestLogEntry } from '@mavonengine/core/Networking/Server/Stats/RequestLog'
import type { ServerMetricsSnapshot } from '@mavonengine/core/Networking/Server/Stats/ServerMetrics'

export type { ServerMetricsSnapshot }
export type LogLine = LogEntry
export type RequestLine = RequestLogEntry

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
