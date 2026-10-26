import type { IncomingMessage, Server as NodeServer, ServerResponse } from 'node:http'
import type { Duplex } from 'node:stream'
import { Buffer } from 'node:buffer'
import { performance } from 'node:perf_hooks'

export interface RequestLogEntry {
  /** Increases by one per entry, so clients can ask for what they haven't seen */
  id: number
  /** When the request arrived */
  timestamp: number
  /** HTTP method, or `WS` for a WebSocket upgrade */
  method: string
  /** Path without the query string, which can hold tokens */
  path: string
  /** Response status, null when the connection closed before one was sent */
  status: number | null
  /** Until the response finished, or until the handshake answer for a WebSocket */
  durationMs: number
  /** Bytes written to the connection for this response, headers included */
  bytes: number
  address: string | null
}

export interface RequestLogResponse {
  entries: RequestLogEntry[]
  /** Id of the newest entry, 0 when nothing was recorded yet */
  latestId: number
}

/** Requests the dashboard makes every poll, which would bury everything else */
export const UNLOGGED_PATHS = new Set(['/api/game/metrics', '/api/game/logs', '/api/game/requests'])

const STATUS_LINE_RE = /^HTTP\/\d(?:\.\d)? (\d{3})/

/**
 * Keeps the most recent requests to a Node HTTP server in memory so they can be served to the dashboard.
 * It listens on the server itself rather than inside Express, so static files, the Vite dev server,
 * geckos.io signaling and WebSocket upgrades show up too.
 */
export default class RequestLog {
  private entries: RequestLogEntry[] = []
  private nextId = 1

  constructor(private capacity = 500) { }

  /**
   * Record every request and WebSocket upgrade `server` receives from now on.
   */
  attach(server: NodeServer) {
    // First in line, so nothing has been written yet when a request is picked up
    server.prependListener('request', (req: IncomingMessage, res: ServerResponse) => this.onRequest(req, res))
    server.prependListener('upgrade', (req: IncomingMessage, socket: Duplex) => {
      this.onUpgrade(req, socket)

      // With no other listener, Node would have closed the connection. Listening must not change that
      if (server.listenerCount('upgrade') === 1)
        socket.destroy()
    })
  }

  push(entry: Omit<RequestLogEntry, 'id'>) {
    this.entries.push({ id: this.nextId++, ...entry })

    if (this.entries.length > this.capacity)
      this.entries.splice(0, this.entries.length - this.capacity)
  }

  /**
   * Entries newer than `afterId`, oldest first.
   */
  since(afterId = 0): RequestLogResponse {
    return {
      entries: this.entries.filter(entry => entry.id > afterId),
      latestId: this.nextId - 1,
    }
  }

  private onRequest(req: IncomingMessage, res: ServerResponse) {
    const path = pathOf(req)
    if (UNLOGGED_PATHS.has(path))
      return

    const timestamp = Date.now()
    const start = performance.now()
    // Keep-alive connections carry one request after another, so the difference is this response
    const written = req.socket.bytesWritten

    res.once('close', () => this.push({
      timestamp,
      method: req.method ?? '?',
      path,
      status: res.headersSent ? res.statusCode : null,
      durationMs: performance.now() - start,
      bytes: req.socket.bytesWritten - written,
      address: req.socket.remoteAddress ?? null,
    }))
  }

  /**
   * Upgrades are answered by writing straight to the socket, so the first write carries the status line.
   */
  private onUpgrade(req: IncomingMessage, socket: Duplex) {
    const timestamp = Date.now()
    const start = performance.now()
    let recorded = false
    const write = socket.write

    const record = (status: number | null, bytes: number) => {
      if (recorded)
        return
      recorded = true
      socket.write = write
      this.push({
        timestamp,
        method: 'WS',
        path: pathOf(req),
        status,
        durationMs: performance.now() - start,
        bytes,
        address: req.socket.remoteAddress ?? null,
      })
    }

    socket.write = function (this: Duplex, chunk: any, ...rest: any[]) {
      const head = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('latin1', 0, 32) : ''
      const status = STATUS_LINE_RE.exec(head)?.[1]
      record(status ? Number(status) : null, typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk?.length ?? 0)
      return write.apply(this, [chunk, ...rest] as Parameters<Duplex['write']>)
    } as Duplex['write']

    socket.once('close', () => record(null, 0))
  }
}

function pathOf(req: IncomingMessage) {
  const url = req.url ?? '/'
  const query = url.indexOf('?')
  return query === -1 ? url : url.slice(0, query)
}
