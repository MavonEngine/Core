import type { IncomingMessage, ServerResponse } from 'node:http'
import type { BridgeClientInfo, BridgeQuery, BridgeRequest, BridgeResponse } from '../Dev/bridgeProtocol.js'
import { Buffer } from 'node:buffer'
import { randomUUID, timingSafeEqual } from 'node:crypto'
import process from 'node:process'
import { AUTO_CLIENT_ID, BRIDGE_ANNOUNCE, BRIDGE_CLIENTS_PATH, BRIDGE_HELLO, BRIDGE_QUERIES, BRIDGE_REQUEST, BRIDGE_RESPONSE, TRACE_GRACE_MS, traceDuration } from '../Dev/bridgeProtocol.js'

/** The parts of Vite's WebSocket server the hub uses */
export interface BridgeSocketServer {
  on(event: string, listener: (data: any, client: BridgeSocketClient) => void): void
  send(event: string, payload?: unknown): void
}

/** Vite hands listeners one object per connection, with only `send` */
export interface BridgeSocketClient {
  send(event: string, payload?: unknown): void
}

interface ConnectedTab {
  info: BridgeClientInfo
  client: BridgeSocketClient
  connectedAt: number
}

export class BridgeError extends Error {
  constructor(message: string, readonly status: number) {
    super(message)
  }
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const ROUTE_RE = new RegExp(`^${BRIDGE_CLIENTS_PATH}(?:/([^/]+)/([a-z]+))?/?$`)

/** Slower queries: a screenshot encodes an image, status waits up to 4s for two frames */
const QUERY_TIMEOUT_MS: Partial<Record<BridgeQuery, number>> = { screenshot: 10000, status: 7000 }

/** A trace records for its duration before it answers */
function queryTimeout(query: BridgeQuery, params: Record<string, string>): number | undefined {
  return query === 'trace' ? traceDuration(params.durationMs) + TRACE_GRACE_MS : QUERY_TIMEOUT_MS[query]
}

/**
 * Keeps track of the game tabs connected to the Vite dev server and asks them questions over Vite's WebSocket.
 */
export class DevBridgeHub {
  private tabs = new Map<string, ConnectedTab>()
  private pending = new Map<string, { resolve(data: unknown): void, reject(err: Error): void, timer: ReturnType<typeof setTimeout> }>()

  constructor(private ws: BridgeSocketServer, private timeoutMs = 5000) {
    ws.on(BRIDGE_HELLO, (info: BridgeClientInfo, client) => this.hello(info, client))
    ws.on(BRIDGE_RESPONSE, (response: BridgeResponse) => this.settle(response))
    ws.on('vite:client:disconnect', (_data, client) => this.disconnect(client))
  }

  private hello(info: BridgeClientInfo, client: BridgeSocketClient) {
    if (!info || typeof info.id !== 'string')
      return

    // A reload keeps the id but connects again
    this.tabs.set(info.id, { info, client, connectedAt: Date.now() })
  }

  private disconnect(client: BridgeSocketClient) {
    for (const [id, tab] of this.tabs) {
      if (tab.client === client)
        this.tabs.delete(id)
    }
  }

  private settle(response: BridgeResponse) {
    const pending = response && this.pending.get(response.requestId)
    if (!pending)
      return

    clearTimeout(pending.timer)
    this.pending.delete(response.requestId)
    if (response.ok)
      pending.resolve(response.data)
    else
      pending.reject(new BridgeError(response.error, 422))
  }

  get size() {
    return this.tabs.size
  }

  /**
   * The open tabs with their current state. Tabs opened before Vite started are asked to announce themselves first
   */
  async list(): Promise<(BridgeClientInfo & { connectedFor: number, stale?: boolean })[]> {
    if (this.tabs.size === 0) {
      this.ws.send(BRIDGE_ANNOUNCE)
      await new Promise(resolve => setTimeout(resolve, 300))
    }

    return Promise.all(Array.from(this.tabs.values(), async (tab) => {
      const connectedFor = Math.round((Date.now() - tab.connectedAt) / 1000)
      try {
        tab.info = await this.ask(tab.info.id, 'info', {}, 2500) as BridgeClientInfo
        return { ...tab.info, connectedFor }
      }
      catch {
        // Busy or frozen: what it last told us
        return { ...tab.info, connectedFor, stale: true }
      }
    }))
  }

  /**
   * The id of the tab to ask: `auto` picks the only tab, or the only one not running the editor
   */
  resolve(id: string): string {
    if (id !== AUTO_CLIENT_ID) {
      if (!this.tabs.has(id))
        throw new BridgeError(`No open game tab with id ${id}`, 404)
      return id
    }

    const tabs = [...this.tabs.values()]
    if (tabs.length === 0)
      throw new BridgeError('No game tab is open. Open the game in a browser while the dev server runs', 404)
    if (tabs.length === 1)
      return tabs[0]!.info.id

    const players = tabs.filter(tab => !tab.info.editor)
    if (players.length === 1)
      return players[0]!.info.id

    throw new BridgeError(`${tabs.length} game tabs are open, pick one by id: ${tabs.map(tab => `${tab.info.id} (${tab.info.editor ? 'editor' : 'player'} ${tab.info.url})`).join(', ')}`, 409)
  }

  ask(id: string, query: BridgeQuery, params: Record<string, string>, timeoutMs = queryTimeout(query, params) ?? this.timeoutMs): Promise<unknown> {
    const tab = this.tabs.get(this.resolve(id))!
    const requestId = randomUUID()

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(requestId)
        reject(new BridgeError(`The game tab ${tab.info.id} did not answer within ${timeoutMs}ms`, 504))
      }, timeoutMs)

      this.pending.set(requestId, { resolve, reject, timer })
      tab.client.send(BRIDGE_REQUEST, { requestId, query, params } satisfies BridgeRequest)
    })
  }
}

/**
 * GET /__mavonengine/clients and GET /__mavonengine/clients/<id|auto>/<query>?<params>.
 * Only localhost, or `Authorization: Bearer $MAVONENGINE_METRICS_TOKEN` when that variable is set.
 * Returns false for requests it doesn't handle.
 */
export function handleBridgeRequest(hub: DevBridgeHub, req: IncomingMessage, res: ServerResponse, env: Record<string, string | undefined> = process.env): boolean {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const match = ROUTE_RE.exec(url.pathname)
  if (!match || (req.method !== 'GET' && req.method !== 'HEAD'))
    return false

  const send = (status: number, body: unknown) => {
    res.statusCode = status
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(JSON.stringify(body))
  }

  const token = env.MAVONENGINE_METRICS_TOKEN
  if (token) {
    const header = req.headers.authorization
    const provided = header?.startsWith('Bearer ') ? header.slice(7) : url.searchParams.get('token')
    if (typeof provided !== 'string' || !safeEqual(provided, token)) {
      send(401, { error: 'Invalid metrics token' })
      return true
    }
  }
  else if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) {
    send(403, { error: 'The dev bridge only answers localhost unless MAVONENGINE_METRICS_TOKEN is set' })
    return true
  }

  const [, id, query] = match
  const reply = (work: Promise<unknown>) => work.then(
    data => send(200, data),
    err => send(err instanceof BridgeError ? err.status : 500, { error: (err as Error).message }),
  )

  if (!id) {
    void reply(hub.list().then(clients => ({ clients })))
    return true
  }

  if (!BRIDGE_QUERIES.includes(query as BridgeQuery)) {
    send(400, { error: `Unknown query ${query}, expected one of ${BRIDGE_QUERIES.join(', ')}` })
    return true
  }

  const params = Object.fromEntries([...url.searchParams].filter(([key]) => key !== 'token'))
  void reply(Promise.resolve().then(() => hub.ask(decodeURIComponent(id), query as BridgeQuery, params)))
  return true
}

function safeEqual(a: string, b: string) {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}
