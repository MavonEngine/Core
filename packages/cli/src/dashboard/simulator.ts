import type { MetricsSource } from './MetricsClient'
import type { LogLine, PluginLine, RequestLine, RouteLine, ServerMetricsSnapshot } from './snapshot'

const HISTORY_LENGTH = 60
/** As many as a real server keeps */
const PACKET_LIMIT = 2000
/** State updates per player and second in the simulation: fewer than the tick rate, so the list stays readable */
const STATES_PER_SECOND = 5

const SIMULATED_PLUGINS: PluginLine[] = [
  {
    package: '@mavonengine/http-monitoring',
    enabled: true,
    installed: true,
    runningOnServer: true,
    version: '0.0.1',
    description: 'The game server dashboard in the browser, behind HTTP Basic auth',
    license: 'MIT',
    target: 'server',
    engine: '^0.0.22',
    declaredPrefabs: [],
    usedPrefabs: [],
  },
  {
    package: '@acme/forest',
    enabled: true,
    installed: true,
    runningOnServer: false,
    version: '2.3.1',
    description: 'Trees and rocks to place in a scene',
    license: 'MIT',
    target: 'client',
    declaredPrefabs: ['Tree', 'Rock'],
    usedPrefabs: ['Tree'],
  },
  { package: 'chat', enabled: false, installed: true, runningOnServer: false, version: '1.0.0', target: 'both', declaredPrefabs: [], usedPrefabs: [] },
]

const SIMULATED_ROUTES: RouteLine[] = [
  { method: 'GET', path: '/api/game/health', source: 'engine', params: {}, devOnly: false, summary: 'Whether the server is up' },
  { method: 'GET', path: '/api/game/metrics', source: 'engine', params: {}, devOnly: false, summary: 'Server statistics' },
  { method: 'GET', path: '/api/game/logs', source: 'engine', params: {}, devOnly: false, summary: 'Recent server log entries' },
  { method: 'GET', path: '/api/game/requests', source: 'engine', params: {}, devOnly: false, summary: 'Recent HTTP requests to this server' },
  { method: 'GET', path: '/api/game/routes', source: 'engine', params: {}, devOnly: false, summary: 'Every HTTP endpoint of this server' },
  { method: 'GET', path: '/api/game/dev/scene', source: 'engine', params: {}, devOnly: true, summary: 'The active scene' },
  { method: 'GET', path: '/api/scores', source: 'game', params: {}, devOnly: false, summary: 'The high scores' },
  { method: 'POST', path: '/api/scores/:player', source: 'game', params: { player: 'Id of the player' }, devOnly: false },
  { method: 'GET', path: '/monitoring', source: 'plugin', plugin: '@mavonengine/http-monitoring', params: {}, devOnly: false },
  { method: 'GET', path: '/monitoring/api/metrics', source: 'plugin', plugin: '@mavonengine/http-monitoring', params: {}, devOnly: false },
]

/**
 * Small deterministic PRNG so --sim output is the same every run.
 */
function mulberry32(seed: number) {
  return () => {
    seed |= 0
    seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function push<T>(history: T[], item: T) {
  history.push(item)
  if (history.length > HISTORY_LENGTH)
    history.shift()
}

/**
 * A fake game server, for working on the dashboard without running one.
 * Each fetch advances the simulation by one sample.
 */
export function simulatedSource(seed = 1, sampleIntervalMs = 1000): MetricsSource {
  const random = mulberry32(seed)
  const tickRate = 30
  const budgetMs = Math.round((1000 / tickRate) * 100) / 100

  let step = 0
  let now = Date.UTC(2026, 0, 1)
  let sequence = 0

  const cpuHistory: ServerMetricsSnapshot['cpu']['history'] = []
  const bandwidthHistory: ServerMetricsSnapshot['bandwidth']['history'] = []
  const tickHistory: ServerMetricsSnapshot['tick']['history'] = []

  const logs: LogLine[] = []
  let previousPlayers = 0
  const joinedAt: number[] = []
  const log = (level: string, message: string) => {
    logs.push({ id: logs.length + 1, timestamp: now, level, message })
  }
  const requests: RequestLine[] = []
  const request = (method: string, path: string, status: number | null, bytes: number, address: string) => {
    requests.push({ id: requests.length + 1, timestamp: now, method, path, status, durationMs: Math.round((1 + random() * 20) * 100) / 100, bytes, address })
  }

  // The game socket's traffic, in the shape of GET /api/game/dev/net/packets
  const packets: Record<string, unknown>[] = []
  let packetId = 0
  let tick = 0
  let syncPlayers: Record<string, unknown>[] = []
  const record = (entry: Record<string, unknown>, offsetMs = 0) => {
    packets.push({ id: ++packetId, timestamp: now + offsetMs, hasPayload: entry.kind === 'packet', ...entry })
    if (packets.length > PACKET_LIMIT)
      packets.shift()
  }

  log('info', 'Starting @mavon/engine - Socket Server')
  log('info', 'Starting @mavon/engine - HTTP Server')

  return {
    label: 'simulation',
    async fetch() {
      step++
      now += sampleIntervalMs
      sequence += tickRate

      // Players drift in and out on a slow wave
      const playerCount = Math.max(1, Math.round(6 + 5 * Math.sin(step / 20) + random() * 2))
      for (let i = previousPlayers; i < playerCount; i++)
        joinedAt[i] = now

      const players = Array.from({ length: playerCount }, (_, i) => ({
        id: `sim-${(i + 1).toString().padStart(2, '0')}`,
        displayName: `Player ${i + 1}`,
        position: {
          x: Math.round(Math.cos(step / 10 + i) * (10 + i * 3) * 100) / 100,
          y: 0,
          z: Math.round(Math.sin(step / 10 + i) * (10 + i * 3) * 100) / 100,
        },
        lastProcessedSequenceId: sequence - Math.floor(random() * 3),
        trackedEntities: playerCount + 20 + Math.floor(random() * 5),
        connectedFor: Math.round((now - joinedAt[i]) / 1000),
        connection: {
          address: `203.0.113.${10 + i}`,
          rttMs: Math.round(20 + i * 8 + random() * 10),
          bytesSent: Math.round((now - joinedAt[i]) * (25 + i)),
          bytesReceived: Math.round((now - joinedAt[i]) * (4 + i / 2)),
        },
      }))

      for (let i = previousPlayers; i < playerCount; i++) {
        // What a browser loading the client and joining asks for
        const address = players[i].connection.address
        request('GET', '/', 200, 1240, address)
        const cached = step % 3 === 0
        request('GET', '/assets/index-4f2a9c1e.js', cached ? 304 : 200, cached ? 210 : 412_000, address)
        request('GET', '/favicon.ico', 404, 160, address)
        request('POST', '/.wrtc/v2/connections', 200, 2900, address)
        request('POST', `/.wrtc/v2/connections/${players[i].id}/additional-candidates`, 200, 600, address)
        record({ kind: 'event', type: 'connect', peer: players[i].id })
        record({ kind: 'packet', direction: 'in', type: 'cl_init', peer: players[i].id, bytes: 24, reliable: true })
        record({ kind: 'event', type: 'sync_enter', peer: players[i].id, tick, info: { count: players[i].trackedEntities } })
        log('info', `Connected: ${players[i].id}`)
        log('info', `${i + 1} total players connected`)
      }
      for (let i = previousPlayers - 1; i >= playerCount; i--) {
        record({ kind: 'event', type: 'disconnect', peer: `sim-${(i + 1).toString().padStart(2, '0')}` })
        log('info', `Disconnected sim-${(i + 1).toString().padStart(2, '0')}`)
        log('info', `${i} total players connected`)
      }
      previousPlayers = playerCount

      // One second of traffic, spread over the sample
      const lastStates = new Map<string, { tick: number, bytes: number, entities: number }>()
      for (let state = 0; state < STATES_PER_SECOND; state++) {
        const offset = Math.round(state * sampleIntervalMs / STATES_PER_SECOND) - sampleIntervalMs
        tick += tickRate / STATES_PER_SECOND
        for (const player of players) {
          const bytes = 180 + player.trackedEntities * 96 + Math.floor(random() * 40)
          if (state % 2 === 0)
            record({ kind: 'packet', direction: 'in', type: 'command', peer: player.id, bytes: 58, sequenceId: player.lastProcessedSequenceId, info: { command: 'cl_move' } }, offset)
          record({ kind: 'packet', direction: 'out', type: 'sv_state', peer: player.id, bytes, tick, info: { entities: player.trackedEntities, ack: player.lastProcessedSequenceId } }, offset + 2)
          lastStates.set(player.id, { tick, bytes, entities: player.trackedEntities })
        }
      }
      for (const player of players) {
        record({ kind: 'packet', direction: 'in', type: 'ping', peer: player.id, bytes: 0 })
        record({ kind: 'packet', direction: 'out', type: 'pong', peer: player.id, bytes: 0 })
      }
      if (step % 9 === 0)
        record({ kind: 'event', type: 'sync_leave', peer: players[0].id, tick, info: { count: 2, entities: ['rock-12', 'rock-40'] } })
      if (step % 13 === 0)
        record({ kind: 'event', type: 'dropped', peer: players.at(-1)!.id, info: { reason: 'DROPPED_FROM_BUFFERING', message: 'sv_state' } })
      if (step % 4 === 0)
        record({ kind: 'packet', direction: 'out', type: 'sv_chat', peer: players[0].id, bytes: 74, reliable: true })

      syncPlayers = players.map(player => ({
        id: player.id,
        displayName: player.displayName,
        position: player.position,
        ack: player.lastProcessedSequenceId,
        tracked: Array.from({ length: player.trackedEntities }, (_, i) => `entity-${i}`),
        lastState: lastStates.get(player.id) ?? null,
      }))

      if (step % 10 === 0)
        request('GET', '/api/game/health', 200, 180, '198.51.100.7')
      if (step % 23 === 0)
        request('GET', '/wp-login.php', 404, 160, '192.0.2.66')

      if (step % 5 === 0)
        log('debug', `Client - Sent: ${playerCount * 4200} B, Received: ${playerCount * 600} B`)

      const cpu = Math.max(0, 12 + playerCount * 2.5 + Math.sin(step / 7) * 6 + random() * 4)
      push(cpuHistory, { timestamp: now, cpuPercentage: Math.round(cpu * 100) / 100 })

      const sent = Math.round(playerCount * (900 + random() * 300) * tickRate * sampleIntervalMs / 1000)
      const received = Math.round(playerCount * (120 + random() * 60) * tickRate * sampleIntervalMs / 1000)
      push(bandwidthHistory, { timestamp: now, sent, received })

      // Occasional spike so the max line has something to show
      const avgMs = 2 + playerCount * 0.6 + random() * 1.5
      const maxMs = avgMs + random() * 3 + (step % 17 === 0 ? 25 : 0)
      if (maxMs > budgetMs)
        log('warn', `Slow tick: ${maxMs.toFixed(1)} ms (budget ${budgetMs} ms)`)
      const commandsPerSecond = playerCount * tickRate
      push(tickHistory, {
        timestamp: now,
        ticks: tickRate,
        ticksPerSecond: tickRate - (maxMs > budgetMs ? 1 : 0),
        avgMs: Math.round(avgMs * 100) / 100,
        maxMs: Math.round(maxMs * 100) / 100,
        commandsPerSecond,
        maxCommandsPerTick: playerCount + Math.floor(random() * 3),
      })

      const average = (ms: number) => {
        const recent = cpuHistory.slice(-Math.max(1, Math.round(ms / sampleIntervalMs)))
        return Math.round(recent.reduce((acc, h) => acc + h.cpuPercentage, 0) / recent.length * 100) / 100
      }

      const heapUsed = 60e6 + playerCount * 2e6 + (step % 30) * 1e6

      const snapshot: ServerMetricsSnapshot = {
        schemaVersion: 1,
        engineVersion: 'simulated',
        serverTime: new Date(now).toISOString(),
        uptime: Math.round(step * sampleIntervalMs / 1000),
        sampleIntervalMs,
        tickRate,
        players,
        world: { entities: playerCount + 140 },
        physics: { bodies: playerCount + 120, colliders: playerCount + 180 },
        cpu: {
          current: cpuHistory.at(-1)!.cpuPercentage,
          avg1s: average(1000),
          avg10s: average(10000),
          avg60s: average(60000),
          history: [...cpuHistory],
        },
        bandwidth: {
          sentPerSecond: Math.round(sent * 1000 / sampleIntervalMs),
          receivedPerSecond: Math.round(received * 1000 / sampleIntervalMs),
          history: [...bandwidthHistory],
        },
        tick: {
          budgetMs,
          latest: tickHistory.at(-1)!,
          history: [...tickHistory],
        },
        memory: {
          rss: heapUsed + 80e6,
          heapUsed,
          heapTotal: heapUsed + 30e6,
          external: 5e6,
        },
        latencySimulation: null,
      }

      return snapshot
    },
    async fetchLogs(afterId) {
      return { entries: logs.filter(entry => entry.id > afterId), latestId: logs.length }
    },
    async fetchRequests(afterId) {
      return { entries: requests.filter(entry => entry.id > afterId), latestId: requests.length }
    },
    async fetchPackets(afterId) {
      const records = packets.filter(entry => (entry.id as number) > afterId)
      return { enabled: true, latestId: packetId, matched: records.length, records }
    },
    async fetchPacket(id) {
      const found = packets.find(entry => entry.id === id)
      if (!found)
        return { record: null }
      if (found.kind === 'event' || !found.bytes)
        return { record: found }

      const info = (found.info ?? {}) as { entities?: number, ack?: number }
      const payload = found.type === 'sv_state'
        ? {
            type: 'sv_state',
            sequenceId: 0,
            tick: found.tick,
            serverTime: found.timestamp,
            ack: info.ack,
            entities: Array.from({ length: info.entities ?? 0 }, (_, i) => ({
              id: i === 0 ? found.peer : `entity-${i}`,
              $typeName: i === 0 ? 'player' : 'rock',
              position: { x: i * 3, y: 0, z: -i * 2 },
              rotation: { x: 0, y: (i % 6) / 2, z: 0 },
              scale: { x: 1, y: 1, z: 1 },
            })),
          }
        : found.type === 'command'
          ? { type: 'cl_move', sequenceId: found.sequenceId, keys: ['KeyW'], yaw: 1.57 }
          : found.type === 'cl_init'
            ? { name: `Player ${String(found.peer).slice(-2)}` }
            : { playerId: found.peer, playerName: 'Player 1', message: 'hello' }

      return { record: { ...found, payload } }
    },
    async fetchSync() {
      const entities = [
        ...syncPlayers.map(player => ({ id: player.id, type: 'player', player: true, trackedBy: syncPlayers.length })),
        // The last few are out of every player's range
        ...Array.from({ length: 140 }, (_, i) => ({ id: `entity-${i}`, type: 'rock', player: false, trackedBy: i < 134 ? 1 + (i % syncPlayers.length) : 0 })),
      ]
      return { tick, serverTime: now, tickRate, syncDistance: 200, players: syncPlayers, editors: [], entities }
    },
    async fetchRoutes() {
      return { routes: SIMULATED_ROUTES }
    },
    async fetchPlugins() {
      return { plugins: SIMULATED_PLUGINS }
    },
  }
}
