/**
 * The dev bridge between open game tabs and the Vite dev server, over Vite's HMR WebSocket.
 * Only exists while Vite serves the client: it is never part of a build.
 *
 * tab  ── hello ───────▶ Vite   (on load and on every reconnect)
 * Vite ── request ─────▶ tab    (for GET /__mavonengine/clients/<id>/<query>)
 * tab  ── response ────▶ Vite
 */

export const BRIDGE_HELLO = 'mavonengine:bridge:hello'
export const BRIDGE_REQUEST = 'mavonengine:bridge:request'
export const BRIDGE_RESPONSE = 'mavonengine:bridge:response'
/** Sent by Vite when it starts, so tabs that were already open announce themselves again */
export const BRIDGE_ANNOUNCE = 'mavonengine:bridge:announce'

/** HTTP routes on the Vite dev server: GET <path> lists the tabs, GET <path>/<id>/<query> asks one */
export const BRIDGE_CLIENTS_PATH = '/__mavonengine/clients'

/** Client id that picks the only open game tab (the only one not running the editor, if there are several) */
export const AUTO_CLIENT_ID = 'auto'

export const BRIDGE_QUERIES = ['info', 'status', 'entities', 'entity', 'scene', 'network', 'logs', 'screenshot', 'trace'] as const
export type BridgeQuery = typeof BRIDGE_QUERIES[number]

/** Trace length limits, in ms. The dev server waits this long plus TRACE_GRACE_MS for the tab to answer */
export const TRACE_DEFAULT_MS = 3000
export const TRACE_MAX_MS = 15000
export const TRACE_GRACE_MS = 10000

/** How long a trace of `durationMs` (a query param) records, within the limits */
export function traceDuration(durationMs: string | number | undefined): number {
  const ms = Number(durationMs)
  return Number.isFinite(ms) && ms > 0 ? Math.min(Math.max(Math.round(ms), 100), TRACE_MAX_MS) : TRACE_DEFAULT_MS
}

export interface BridgeClientInfo {
  /** Stays the same across reloads of the tab */
  id: string
  url: string
  title: string
  userAgent: string
  /** Socket id of the game connection, which is the player's entity id on the server */
  playerId: string | null
  editor: boolean
  visible: boolean
  focused: boolean
  fps: number | null
}

export interface BridgeRequest {
  requestId: string
  query: BridgeQuery
  params: Record<string, string>
}

export type BridgeResponse
  = | { requestId: string, ok: true, data: unknown }
    | { requestId: string, ok: false, error: string }
