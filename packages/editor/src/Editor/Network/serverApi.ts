import type { NetRecordDetail, NetRecordList, NetRecordQuery } from '@mavonengine/core/Networking/Debug/NetRecorder'
import type { SyncSnapshot } from '@mavonengine/core/Networking/Debug/sync'

/**
 * The game server's network debug endpoints (GET /api/game/dev/net/*), read by the editor.
 *
 * They are asked on the page's own origin, which is where the game server serves the client in dev.
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

async function get<T>(path: string, params: Record<string, unknown> = {}, fetchFn: typeof fetch = fetch): Promise<T> {
  const search = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '')
      search.set(key, String(value))
  }
  const query = search.toString()

  let res: Response
  try {
    res = await fetchFn(`${serverUrl()}/api/game/dev/net/${path}${query ? `?${query}` : ''}`)
  }
  catch {
    throw new Error('The game server is not reachable')
  }

  if (res.status === 404 || !res.headers.get('content-type')?.includes('application/json'))
    throw new Error('The game server has no network debug endpoints here. They are served in development, on the origin of this page')
  if (!res.ok)
    throw new Error(`The game server answered ${res.status} ${res.statusText}`)

  return res.json() as Promise<T>
}

export function fetchSync(fetchFn?: typeof fetch) {
  return get<SyncSnapshot>('sync', {}, fetchFn)
}

export function fetchPackets(query: NetRecordQuery, fetchFn?: typeof fetch) {
  return get<NetRecordList>('packets', { ...query }, fetchFn)
}

export async function fetchPacket(id: number, fetchFn?: typeof fetch) {
  return (await get<{ record: NetRecordDetail | null }>(`packets/${id}`, {}, fetchFn)).record
}
