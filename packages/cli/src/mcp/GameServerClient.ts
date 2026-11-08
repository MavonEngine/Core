export interface GameServerClientOptions {
  /** Base URL of the game server's HTTP API, e.g. http://localhost:8050 */
  url: string
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

const DEV_UNAVAILABLE = 'The dev endpoints are not available: the game server runs with NODE_ENV=production '
  + '(they are never served there), or it uses a @mavonengine/core release without them'

/**
 * Reads a running game server's HTTP API (/api/game/*) for the MCP tools.
 */
export default class GameServerClient {
  readonly url: string
  private base: URL
  private token?: string
  private timeoutMs: number
  private fetchImpl: typeof globalThis.fetch

  constructor({ url, token, timeoutMs = 3000, fetch = globalThis.fetch }: GameServerClientOptions) {
    // Paths resolve relative to the base, so a server behind a path prefix works too
    this.base = new URL(url.endsWith('/') ? url : `${url}/`)
    this.url = this.base.href
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
