import type { HttpRouteInfo, HttpRouteList } from '@mavonengine/core/Networking/Server/Http/RouteInfo'

export type { HttpRouteInfo }

/**
 * The game server's list of HTTP endpoints (GET /api/game/routes), read by the editor's Server panel.
 *
 * It is asked on the page's own origin, which is where the game server serves the client in dev.
 * For a client served elsewhere, put the server's URL in `localStorage['mavonengine:server-url']`;
 * the server then has to allow that origin (CORS).
 */
export const SERVER_URL_KEY = 'mavonengine:server-url'

const TRAILING_SLASH_RE = /\/$/

export function serverUrl(): string {
  try {
    return (localStorage.getItem(SERVER_URL_KEY) ?? '').replace(TRAILING_SLASH_RE, '')
  }
  catch {
    return ''
  }
}

export async function fetchRoutes(fetchFn: typeof fetch = fetch): Promise<HttpRouteInfo[]> {
  let res: Response
  try {
    res = await fetchFn(`${serverUrl()}/api/game/routes`)
  }
  catch {
    throw new Error('The game server is not reachable')
  }

  // A client served by something else answers with its own page or a 404
  if (res.status === 404 || !res.headers.get('content-type')?.includes('application/json'))
    throw new Error('There is no game server on the origin of this page, or it runs a @mavonengine/core release without GET /api/game/routes')
  if (res.status === 401 || res.status === 403)
    throw new Error('The game server only lists its endpoints to localhost, or with its metrics token')
  if (!res.ok)
    throw new Error(`The game server answered ${res.status} ${res.statusText}`)

  const { routes } = await res.json() as Partial<HttpRouteList>
  return Array.isArray(routes) ? routes : []
}

export interface RouteGroup {
  /** `engine`, `game` or the plugin's package */
  id: string
  /** `Engine`, `Game` or the plugin's package, as shown in the From column */
  from: string
  routes: HttpRouteInfo[]
}

/**
 * Routes by who registered them: the game's own first, then each plugin, the engine's last
 */
export function groupRoutes(routes: HttpRouteInfo[]): RouteGroup[] {
  const groups = new Map<string, RouteGroup>()

  for (const route of routes) {
    const id = route.source === 'plugin' ? route.plugin ?? 'plugin' : route.source
    const from = route.source === 'engine' ? 'Engine' : route.source === 'game' ? 'Game' : id
    if (!groups.has(id))
      groups.set(id, { id, from, routes: [] })
    groups.get(id)!.routes.push(route)
  }

  const rank = (group: RouteGroup) => group.id === 'game' ? 0 : group.id === 'engine' ? 2 : 1
  return [...groups.values()].sort((a, b) => rank(a) - rank(b))
}
