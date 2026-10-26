import type { LogLine, ServerMetricsSnapshot } from './snapshot'
import { normalizeLogs, normalizeSnapshot } from './snapshot'

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
}

/** Log lines kept in memory by the dashboard */
export const MAX_LOG_LINES = 1000

export class MetricsSourceError extends Error {
  constructor(message: string, readonly status: ConnectionStatus) {
    super(message)
  }
}

/**
 * Something that produces one raw metrics snapshot per call,
 * and optionally the log entries newer than a given id.
 */
export interface MetricsSource {
  label: string
  fetch(): Promise<unknown>
  fetchLogs?(afterId: number): Promise<unknown>
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
  }
}

export interface MetricsClientOptions {
  intervalMs?: number
  /** Longest wait between retries while the server is failing */
  maxBackoffMs?: number
}

/**
 * Polls a metrics source and keeps the latest dashboard state.
 * Knows nothing about rendering so it can be tested without a terminal.
 */
export default class MetricsClient {
  readonly state: DashboardState
  private intervalMs: number
  private maxBackoffMs: number
  private timer: ReturnType<typeof setTimeout> | null = null
  private running = false
  private listeners = new Set<(state: DashboardState) => void>()

  constructor(private source: MetricsSource, { intervalMs = 1000, maxBackoffMs = 10000 }: MetricsClientOptions = {}) {
    this.intervalMs = intervalMs
    this.maxBackoffMs = maxBackoffMs
    this.state = {
      status: 'connecting',
      source: source.label,
      snapshot: null,
      lastUpdate: null,
      error: null,
      failures: 0,
      logs: [],
      logsAvailable: source.fetchLogs ? null : false,
    }
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

    await this.loop()
  }

  /**
   * Fetch one snapshot, then any new log lines, and update the state.
   */
  async poll() {
    try {
      const raw = await this.source.fetch()

      this.state.snapshot = normalizeSnapshot(raw)
      this.state.status = 'live'
      this.state.lastUpdate = Date.now()
      this.state.error = null
      this.state.failures = 0

      await this.pollLogs()
    }
    catch (err) {
      this.state.status = err instanceof MetricsSourceError ? err.status : 'unreachable'
      this.state.error = (err as Error).message
      this.state.failures++
    }

    this.listeners.forEach(listener => listener(this.state))
  }

  private lastLogId = 0

  private async pollLogs() {
    if (!this.source.fetchLogs || this.state.logsAvailable === false)
      return

    try {
      let { entries, latestId } = normalizeLogs(await this.source.fetchLogs(this.lastLogId))

      // Ids went backwards, so the server restarted: start over from its first entry
      if (latestId < this.lastLogId) {
        this.state.logs = []
        this.lastLogId = 0;
        ({ entries, latestId } = normalizeLogs(await this.source.fetchLogs(0)))
      }

      this.state.logsAvailable = true
      this.state.logs.push(...entries.filter(entry => entry.id > this.lastLogId))
      this.lastLogId = Math.max(this.lastLogId, latestId)

      if (this.state.logs.length > MAX_LOG_LINES)
        this.state.logs.splice(0, this.state.logs.length - MAX_LOG_LINES)
    }
    catch (err) {
      // Metrics work but logs don't: an older server, or logBufferSize 0
      if (err instanceof MetricsSourceError && err.status === 'disabled')
        this.state.logsAvailable = false
      // Anything else is transient, the next poll tries again
    }
  }

  /**
   * Delay before the next poll: the normal interval, doubling per failure up to maxBackoffMs.
   */
  nextDelay() {
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
