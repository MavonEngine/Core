import type { LogLine, PacketDetail, PacketLine, PluginLine, RequestLine, RouteLine, ServerMetricsSnapshot, SyncInfo } from './snapshot'
import { normalizeLogs, normalizePacketDetail, normalizePackets, normalizePlugins, normalizeRequests, normalizeRoutes, normalizeSnapshot, normalizeSync } from './snapshot'

export type ConnectionStatus = 'connecting' | 'live' | 'unreachable' | 'unauthorized' | 'forbidden' | 'disabled'

export interface DashboardState {
  status: ConnectionStatus
  /** Where metrics come from, shown in the header */
  source: string
  snapshot: ServerMetricsSnapshot | null
  /** Date.now() of the last successful poll */
  lastUpdate: number | null
  error: string | null
  /** Consecutive failed polls */
  failures: number
  /** Recent server log lines, oldest first */
  logs: LogLine[]
  /** false once the server turned out not to serve logs, null until known */
  logsAvailable: boolean | null
  /** Recent HTTP requests to the server, oldest first */
  requests: RequestLine[]
  /** false once the server turned out not to record requests, null until known */
  requestsAvailable: boolean | null
  /** Recent packets and network events of the game socket, oldest first. Only followed while `watchNetwork` is on */
  packets: PacketLine[]
  /** false once the server turned out not to serve them (production, or an older server), null until known */
  packetsAvailable: boolean | null
  /** Who is sent what, null until known or when the server doesn't tell */
  sync: SyncInfo | null
  /** The packet opened with `inspectPacket()`, null when none is */
  packetDetail: PacketDetail | null
  /** The server's HTTP endpoints, in the order it registered them */
  routes: RouteLine[]
  /** false once the server turned out not to list its endpoints, null until known */
  routesAvailable: boolean | null
  /** The plugins of the server's project, in the order of its mavonengine.json */
  plugins: PluginLine[]
  /** false once the server turned out not to list its plugins, null until known */
  pluginsAvailable: boolean | null
}

/** Log lines kept in memory by the dashboard */
export const MAX_LOG_LINES = 1000

/** HTTP requests kept in memory by the dashboard */
export const MAX_REQUEST_LINES = 1000

/** Packets kept in memory by the dashboard: as many as the server keeps, a few seconds of a busy server */
export const MAX_PACKET_LINES = 2000

export class MetricsSourceError extends Error {
  constructor(message: string, readonly status: ConnectionStatus) {
    super(message)
  }
}

/**
 * Something that produces one raw metrics snapshot per call,
 * and optionally the log entries / HTTP requests newer than a given id.
 */
export interface MetricsSource {
  label: string
  fetch(): Promise<unknown>
  fetchLogs?(afterId: number): Promise<unknown>
  fetchRequests?(afterId: number): Promise<unknown>
  /** Packets and network events of the game socket newer than `afterId` */
  fetchPackets?(afterId: number): Promise<unknown>
  /** The server's state sync */
  fetchSync?(): Promise<unknown>
  /** One packet with its payload */
  fetchPacket?(id: number): Promise<unknown>
  fetchRoutes?(): Promise<unknown>
  fetchPlugins?(): Promise<unknown>
}

export interface HttpSourceOptions {
  url: string
  token?: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

export function httpSource({ url, token, timeoutMs = 3000, fetch = globalThis.fetch }: HttpSourceOptions): MetricsSource {
  // Logs live next to metrics: .../api/game/metrics -> .../api/game/logs
  const logsUrl = new URL('logs', url)
  const requestsUrl = new URL('requests', url)
  // Dev only: .../api/game/dev/net/*
  const packetsUrl = new URL('dev/net/packets', url)
  packetsUrl.searchParams.set('limit', String(MAX_PACKET_LINES))
  const syncUrl = new URL('dev/net/sync', url)
  const routesUrl = new URL('routes', url)
  const pluginsUrl = new URL('plugins', url)

  async function request(target: string) {
    let res: Response

    try {
      res = await fetch(target, {
        headers: token ? { Authorization: `Bearer ${token}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      })
    }
    catch (err) {
      throw new MetricsSourceError(`Can't reach ${url}: ${(err as Error).message}`, 'unreachable')
    }

    if (res.status === 401)
      throw new MetricsSourceError('Metrics token missing or wrong (use --token)', 'unauthorized')
    if (res.status === 403)
      throw new MetricsSourceError('Server only allows metrics from localhost without a token (use --token)', 'forbidden')
    if (res.status === 404)
      throw new MetricsSourceError('Metrics endpoint not found: it is disabled, or the server runs a @mavonengine/core release without it', 'disabled')
    if (!res.ok)
      throw new MetricsSourceError(`Server responded ${res.status} ${res.statusText}`, 'unreachable')

    return res.json()
  }

  return {
    label: url,
    fetch: () => request(url),
    fetchLogs: (afterId) => {
      logsUrl.searchParams.set('after', String(afterId))
      return request(logsUrl.toString())
    },
    fetchRequests: (afterId) => {
      requestsUrl.searchParams.set('after', String(afterId))
      return request(requestsUrl.toString())
    },
    fetchPackets: (afterId) => {
      packetsUrl.searchParams.set('after', String(afterId))
      return request(packetsUrl.toString())
    },
    fetchSync: () => request(syncUrl.toString()),
    fetchPacket: id => request(new URL(`dev/net/packets/${id}`, url).toString()),
    fetchRoutes: () => request(routesUrl.toString()),
    fetchPlugins: () => request(pluginsUrl.toString()),
  }
}

/**
 * Follows an endpoint whose entries have increasing ids (logs, HTTP requests),
 * keeping the newest `max` of them.
 */
class Feed<T extends { id: number }> {
  entries: T[] = []
  /** false once the server turned out not to serve it, null until known */
  available: boolean | null
  private lastId = 0

  constructor(
    private fetchPage: ((afterId: number) => Promise<unknown>) | undefined,
    private normalize: (raw: unknown) => { entries: T[], latestId: number },
    private max: number,
  ) {
    this.available = fetchPage ? null : false
  }

  async poll() {
    if (!this.fetchPage || this.available === false)
      return

    try {
      let { entries, latestId } = this.normalize(await this.fetchPage(this.lastId))

      // Ids went backwards, so the server restarted: start over from its first entry
      if (latestId < this.lastId) {
        this.entries = []
        this.lastId = 0;
        ({ entries, latestId } = this.normalize(await this.fetchPage(0)))
      }

      this.available = true
      this.entries.push(...entries.filter(entry => entry.id > this.lastId))
      this.lastId = Math.max(this.lastId, latestId)

      if (this.entries.length > this.max)
        this.entries.splice(0, this.entries.length - this.max)
    }
    catch (err) {
      // Metrics work but this doesn't: an older server, or it is turned off in the server options
      if (err instanceof MetricsSourceError && err.status === 'disabled')
        this.available = false
      // Anything else is transient, the next poll tries again
    }
  }
}

export interface MetricsClientOptions {
  intervalMs?: number
  /** Longest wait between retries while the server is failing */
  maxBackoffMs?: number
  /** Poll this often, without backoff, until the first snapshot arrives. For a server that is still starting */
  startupIntervalMs?: number
  /** How often the HTTP endpoints and the plugins are fetched again. They rarely change, so less often than the metrics */
  routesIntervalMs?: number
}

/**
 * Polls a metrics source and keeps the latest dashboard state.
 * Knows nothing about rendering so it can be tested without a terminal.
 */
export default class MetricsClient {
  readonly state: DashboardState
  private intervalMs: number
  private maxBackoffMs: number
  private startupIntervalMs?: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private listeners = new Set<(state: DashboardState) => void>()
  private logs: Feed<LogLine>
  private requests: Feed<RequestLine>
  private packets: Feed<PacketLine>
  private syncAvailable: boolean

  /**
   * Follow the packets and the state sync too. Off by default: it is a lot of data on a busy server,
   * so the dashboard only turns it on while its Network tab is shown.
   */
  watchNetwork = false
  private routesIntervalMs: number
  /** Date.now() the endpoints and plugins were last fetched, null to fetch them with the next poll */
  private projectFetchedAt: number | null = null

  constructor(private source: MetricsSource, { intervalMs = 1000, maxBackoffMs = 10000, startupIntervalMs, routesIntervalMs = 5000 }: MetricsClientOptions = {}) {
    this.intervalMs = intervalMs
    this.routesIntervalMs = routesIntervalMs
    this.maxBackoffMs = maxBackoffMs
    this.startupIntervalMs = startupIntervalMs
    this.logs = new Feed(source.fetchLogs?.bind(source), normalizeLogs, MAX_LOG_LINES)
    this.requests = new Feed(source.fetchRequests?.bind(source), normalizeRequests, MAX_REQUEST_LINES)
    this.packets = new Feed(source.fetchPackets?.bind(source), normalizePackets, MAX_PACKET_LINES)
    this.syncAvailable = !!source.fetchSync
    this.state = {
      status: 'connecting',
      source: source.label,
      snapshot: null,
      lastUpdate: null,
      error: null,
      failures: 0,
      logs: [],
      logsAvailable: this.logs.available,
      requests: [],
      requestsAvailable: this.requests.available,
      packets: [],
      packetsAvailable: this.packets.available,
      sync: null,
      packetDetail: null,
      routes: [],
      routesAvailable: source.fetchRoutes ? null : false,
      plugins: [],
      pluginsAvailable: source.fetchPlugins ? null : false,
    }
  }

  /**
   * Load the content of one packet into `state.packetDetail`, or close it with null.
   */
  async inspectPacket(id: number | null) {
    if (id === null) {
      this.state.packetDetail = null
      this.notify()
      return
    }

    if (!this.source.fetchPacket) {
      this.state.packetDetail = { id, status: 'error', lines: [], error: 'This source does not serve packet contents' }
      this.notify()
      return
    }

    this.state.packetDetail = { id, status: 'loading', lines: [] }
    this.notify()

    let detail: PacketDetail
    try {
      detail = normalizePacketDetail(id, await this.source.fetchPacket(id))
    }
    catch (err) {
      detail = { id, status: 'error', lines: [], error: (err as Error).message }
    }

    // Another packet was opened, or this one closed, while it loaded
    if (this.state.packetDetail?.id !== id)
      return

    this.state.packetDetail = detail
    this.notify()
  }

  private notify() {
    this.listeners.forEach(listener => listener(this.state))
  }

  onChange(listener: (state: DashboardState) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  start() {
    if (this.running)
      return

    this.running = true
    void this.loop()
  }

  stop() {
    this.running = false

    if (this.timer)
      clearTimeout(this.timer)
    this.timer = null
  }

  /**
   * Poll once now, skipping the wait.
   */
  async refresh() {
    if (this.timer)
      clearTimeout(this.timer)
    this.timer = null
    this.projectFetchedAt = null

    await this.loop()
  }

  /**
   * Fetch one snapshot, then any new log lines and requests, and update the state.
   */
  async poll() {
    try {
      const raw = await this.source.fetch()

      this.state.snapshot = normalizeSnapshot(raw)
      this.state.status = 'live'
      this.state.lastUpdate = Date.now()
      this.state.error = null
      this.state.failures = 0

      await Promise.all([this.logs.poll(), this.requests.poll(), this.pollProject()])
      this.state.logs = this.logs.entries
      this.state.logsAvailable = this.logs.available
      this.state.requests = this.requests.entries
      this.state.requestsAvailable = this.requests.available

      if (this.watchNetwork) {
        await Promise.all([this.packets.poll(), this.pollSync()])
        this.state.packets = this.packets.entries
        this.state.packetsAvailable = this.packets.available
      }
    }
    catch (err) {
      this.state.status = err instanceof MetricsSourceError ? err.status : 'unreachable'
      this.state.error = (err as Error).message
      this.state.failures++
    }

    this.notify()
  }

  private async pollSync() {
    if (!this.syncAvailable)
      return

    try {
      this.state.sync = normalizeSync(await this.source.fetchSync!())
    }
    catch (err) {
      // Not served (production, or an older server): stop asking. Anything else is transient
      if (err instanceof MetricsSourceError && err.status === 'disabled') {
        this.syncAvailable = false
        this.state.sync = null
      }
    }
  }

  /**
   * Fetch the server's HTTP endpoints and plugins, unless they were fetched a moment ago
   */
  private async pollProject(now = Date.now()) {
    if (this.projectFetchedAt !== null && now - this.projectFetchedAt < this.routesIntervalMs)
      return

    const { source, state } = this
    const done = await Promise.all([
      this.fetchList(state.routesAvailable, source.fetchRoutes?.bind(source), (raw) => {
        state.routes = normalizeRoutes(raw)
        state.routesAvailable = true
      }, () => state.routesAvailable = false),
      this.fetchList(state.pluginsAvailable, source.fetchPlugins?.bind(source), (raw) => {
        state.plugins = normalizePlugins(raw)
        state.pluginsAvailable = true
      }, () => state.pluginsAvailable = false),
    ])

    // Whatever failed for now is tried again with the next poll
    if (done.every(Boolean))
      this.projectFetchedAt = now
  }

  /**
   * Returns false when the list could not be fetched this time but may be next time
   */
  private async fetchList(available: boolean | null, fetchList: (() => Promise<unknown>) | undefined, onList: (raw: unknown) => void, onUnavailable: () => void): Promise<boolean> {
    if (!fetchList || available === false)
      return true

    try {
      onList(await fetchList())
      return true
    }
    catch (err) {
      // Metrics work but this doesn't: an older server
      if (err instanceof MetricsSourceError && err.status === 'disabled') {
        onUnavailable()
        return true
      }
      return false
    }
  }

  /**
   * Delay before the next poll: the normal interval, doubling per failure up to maxBackoffMs.
   * The startup interval until the server first answered, if one is set.
   */
  nextDelay() {
    if (this.startupIntervalMs !== undefined && !this.state.snapshot)
      return this.startupIntervalMs

    if (this.state.failures === 0)
      return this.intervalMs

    return Math.min(this.intervalMs * 2 ** this.state.failures, Math.max(this.maxBackoffMs, this.intervalMs))
  }

  private async loop() {
    await this.poll()

    if (this.running && !this.timer) {
      this.timer = setTimeout(() => {
        this.timer = null
        void this.loop()
      }, this.nextDelay())
    }
  }
}
