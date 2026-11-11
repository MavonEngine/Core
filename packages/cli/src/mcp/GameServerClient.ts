export interface GameServerClientOptions {
  /** Base URL of the game server's HTTP API, e.g. http://localhost:8050 */
  url: string
  /**
   * Where the client is served in dev, which answers the dev bridge (/__mavonengine/clients).
   * Default `url`: the template serves the client from the game server. A standalone Vite server is e.g. http://localhost:5173
   */
  clientUrl?: string
  token?: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

export interface EntityQuery {
  type?: string
  near?: { x: number, y: number, z: number }
  radius?: number
  limit?: number
  offset?: number
}

export class GameServerError extends Error { }

export type ClientQuery = 'status' | 'entities' | 'entity' | 'scene' | 'network' | 'packets' | 'packet' | 'logs' | 'screenshot' | 'trace'

export interface PacketQuery {
  after?: number
  kind?: 'packet' | 'event'
  direction?: 'in' | 'out'
  /** Message or event name, several separated by commas */
  type?: string
  /** Channel id of a client, which is its player id */
  peer?: string
  limit?: number
}

const NET_UNAVAILABLE = 'The network debug endpoints are not available: the game server runs with NODE_ENV=production '
  + '(they are never served there), or it uses a @mavonengine/core release without them'

/** A packet query as query string params, without the unset fields */
export function packetParams(query: PacketQuery): Record<string, string> {
  return Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined && value !== '').map(([key, value]) => [key, String(value)]))
}

const DEV_UNAVAILABLE = 'The dev endpoints are not available: the game server runs with NODE_ENV=production '
  + '(they are never served there), or it uses a @mavonengine/core release without them'

/**
 * Reads a running game server's HTTP API (/api/game/*) for the MCP tools.
 */
export default class GameServerClient {
  readonly url: string
  readonly clientUrl: string
  private base: URL
  private clientBase: URL
  private token?: string
  private timeoutMs: number
  private fetchImpl: typeof globalThis.fetch

  constructor({ url, clientUrl, token, timeoutMs = 3000, fetch = globalThis.fetch }: GameServerClientOptions) {
    // Paths resolve relative to the base, so a server behind a path prefix works too
    this.base = new URL(url.endsWith('/') ? url : `${url}/`)
    this.url = this.base.href
    this.clientBase = clientUrl ? new URL(clientUrl.endsWith('/') ? clientUrl : `${clientUrl}/`) : this.base
    this.clientUrl = this.clientBase.href
    this.token = token
    this.timeoutMs = timeoutMs
    this.fetchImpl = fetch
  }

  health() {
    return this.get('api/game/health')
  }

  metrics() {
    return this.get('api/game/metrics')
  }

  logs(afterId = 0) {
    return this.get('api/game/logs', { after: String(afterId) }, 'The server does not keep logs (metrics.logBufferSize is 0)')
  }

  requests(afterId = 0) {
    return this.get('api/game/requests', { after: String(afterId) }, 'The server does not record requests (metrics.requestLogSize is 0)')
  }

  scene() {
    return this.get('api/game/dev/scene', {}, DEV_UNAVAILABLE)
  }

  entities(query: EntityQuery = {}) {
    const params: Record<string, string> = {}
    if (query.type)
      params.type = query.type
    if (query.near)
      params.near = `${query.near.x},${query.near.y},${query.near.z}`
    for (const key of ['radius', 'limit', 'offset'] as const) {
      if (query[key] !== undefined)
        params[key] = String(query[key])
    }

    return this.get('api/game/dev/entities', params, DEV_UNAVAILABLE)
  }

  entity(id: string) {
    return this.get(`api/game/dev/entities/${encodeURIComponent(id)}`, {}, DEV_UNAVAILABLE)
  }

  /** The plugins of the project and whether each runs on the server */
  plugins() {
    return this.get('api/game/plugins', {}, 'The game server doesn\'t list its plugins: it runs a @mavonengine/core release without GET /api/game/plugins, or its metrics endpoints are off')
  }

  /** Every HTTP endpoint of the server, with who registered it */
  routes() {
    return this.get('api/game/routes', {}, 'The game server doesn\'t list its endpoints: it runs a @mavonengine/core release without GET /api/game/routes, or its metrics endpoints are off')
  }

  /** Packets and network events the server recorded, oldest first */
  packets(query: PacketQuery = {}) {
    return this.get('api/game/dev/net/packets', packetParams(query), NET_UNAVAILABLE)
  }

  /** One recorded packet with its payload */
  packet(id: number) {
    return this.get(`api/game/dev/net/packets/${id}`, {}, NET_UNAVAILABLE)
  }

  /** Who is sent which entities */
  sync() {
    return this.get('api/game/dev/net/sync', {}, NET_UNAVAILABLE)
  }

  /** The game tabs open in a browser, through the dev bridge */
  clients() {
    return this.bridge('__mavonengine/clients', {})
  }

  /**
   * Ask one tab. `clientId` defaults to the only open tab (or the only one not running the editor)
   */
  client(query: ClientQuery, params: Record<string, string | number | undefined> = {}, clientId = 'auto') {
    const defined = Object.fromEntries(Object.entries(params).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]))
    // Longer than the dev server waits for the tab: a screenshot is encoded there, status waits for frames, a trace records
    const timeoutMs = query === 'trace'
      ? Number(params.durationMs ?? 3000) + 15000
      : query === 'screenshot' ? 15000 : query === 'status' ? 10000 : 8000
    return this.bridge(`__mavonengine/clients/${encodeURIComponent(clientId)}/${query}`, defined, timeoutMs)
  }

  private async bridge(path: string, params: Record<string, string>, timeoutMs = 5000): Promise<any> {
    const target = new URL(path, this.clientBase)
    for (const [key, value] of Object.entries(params))
      target.searchParams.set(key, value)

    let res: Response
    try {
      res = await this.fetchImpl(target, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(timeoutMs),
      })
    }
    catch (err) {
      throw new GameServerError(`Can't reach the client dev server at ${this.clientUrl}: ${(err as Error).message}. Is it running?`)
    }

    // The bridge always answers JSON; anything else is a page, e.g. Vite's SPA fallback without the bridge
    const isJson = res.headers.get('content-type')?.includes('application/json')
    const body = isJson ? await res.json().catch(() => null) as any : null

    if (!isJson || (res.status === 404 && !body?.error)) {
      throw new GameServerError(`No dev bridge at ${this.clientUrl}. The game client must be served by Vite in dev with the mavonengine Vite plugin `
        + '(@mavonengine/core/vite.config). If Vite runs on its own port, pass --client-url, e.g. http://localhost:5173')
    }
    if (res.status === 401 || res.status === 403)
      throw new GameServerError(`${body?.error ?? 'Not allowed'}: pass --token or set MAVONENGINE_METRICS_TOKEN for both the CLI and the dev server`)
    if (!res.ok)
      throw new GameServerError(body?.error ?? `Client dev server responded ${res.status} ${res.statusText}`)

    return body
  }

  private async get(path: string, params: Record<string, string> = {}, notFound?: string): Promise<any> {
    const target = new URL(path, this.base)
    for (const [key, value] of Object.entries(params))
      target.searchParams.set(key, value)

    let res: Response
    try {
      res = await this.fetchImpl(target, {
        headers: this.token ? { Authorization: `Bearer ${this.token}` } : {},
        signal: AbortSignal.timeout(this.timeoutMs),
      })
    }
    catch (err) {
      throw new GameServerError(`Can't reach the game server at ${this.url}: ${(err as Error).message}. Is it running?`)
    }

    if (res.status === 401)
      throw new GameServerError('Metrics token missing or wrong: pass --token or set MAVONENGINE_METRICS_TOKEN')
    if (res.status === 403)
      throw new GameServerError('The game server only answers localhost without a token: pass --token or set MAVONENGINE_METRICS_TOKEN')
    if (res.status === 404)
      throw new GameServerError(notFound ?? 'Metrics endpoints not found: they are turned off in the server options, or it runs in production without a metrics token')
    if (res.status === 400)
      throw new GameServerError(`Bad request: ${((await res.json().catch(() => null)) as { error?: string } | null)?.error ?? res.statusText}`)
    if (!res.ok)
      throw new GameServerError(`Game server responded ${res.status} ${res.statusText}`)

    return res.json()
  }
}
