import type { ClientPlugin, ClientPluginContext } from '@mavonengine/core/Plugins/types'
import type { GameNotification, ListRequest, NotificationsResult, ReadRequest, StoredNotification } from './protocol'
import { LIST_MESSAGE, NOTIFICATION_EVENT, NOTIFICATION_MESSAGE, READ_MESSAGE, RESULT_MESSAGE, UNREAD_MESSAGE } from './protocol'

export type { GameNotification, StoredNotification } from './protocol'
export { NOTIFICATION_EVENT, NOTIFICATION_MESSAGE } from './protocol'

/** The game event triggered when the account's unread count changes: `game.on(UNREAD_EVENT, (count: number) => …)` */
export const UNREAD_EVENT = 'notifications:unread'

/** How long a request to the server may take before it is given up, in ms */
export const REQUEST_TIMEOUT_MS = 10_000

type Listener = (notification: GameNotification) => void

/** What the game does with notifications in the browser */
export interface NotificationsClient {
  /** Call `listener` with every notification that reaches this game. Returns a function that stops it */
  on(listener: Listener): () => void
  /** Only notifications of one type, e.g. `onType('LevelUp', n => …)` */
  onType<T = unknown>(type: string, listener: (notification: GameNotification<T>) => void): () => void
  /**
   * The account's notifications the server kept (the `database` channel), the latest first, and how many are unread.
   * Rejects when the game isn't connected, the server keeps none, or it doesn't answer in time
   */
  stored(options?: { unread?: boolean, limit?: number, offset?: number }): Promise<{ notifications: StoredNotification[], unread: number }>
  /** Mark notifications read, by their id or the id of their toast, or all of them without ids */
  markRead(ids?: string[]): Promise<{ marked: number, unread: number }>
  /** How many of the account's kept notifications are unread, as the server last said. Undefined before it said */
  readonly unread: number | undefined
  /** Call `listener` whenever the unread count changes, e.g. for a badge. Returns a function that stops it */
  onUnread(listener: (unread: number) => void): () => void
}

declare module '@mavonengine/core/Plugins/types' {
  interface ClientPluginApis {
    '@mavonengine/notifications': NotificationsClient
  }
}

/** The parts of the game's connection used, which is what geckos.io's ClientChannel has */
interface Socket {
  on(event: string, callback: (data: unknown) => void): void
  emit(event: string, data: unknown, options?: { reliable?: boolean }): void
}

interface GameLike {
  trigger?(name: string, event?: unknown): void
  network?: { socket?: Socket }
}

interface Pending {
  resolve(result: NotificationsResult): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

interface ClientState {
  game: GameLike
  socket?: Socket
  listeners: Set<Listener>
  unreadListeners: Set<(unread: number) => void>
  unread?: number
  pending: Map<string, Pending>
  nextRequest: number
  logger?: ClientPluginContext['logger']
  api: NotificationsClient
}

/** Kept on globalThis, so the game and the plugin share it even with two copies of this module in the bundle */
const STATES = Symbol.for('mavonengine.notifications.clients')

function setUnread(state: ClientState, unread: unknown) {
  if (typeof unread !== 'number' || unread === state.unread)
    return
  state.unread = unread
  state.game.trigger?.(UNREAD_EVENT, unread)
  for (const listener of state.unreadListeners) {
    try {
      listener(unread)
    }
    catch (err) {
      state.logger?.error(`Notifications: an unread listener failed: ${(err as Error)?.stack ?? err}`)
    }
  }
}

function request(state: ClientState, event: string, body: Omit<ListRequest, 'requestId'> | Omit<ReadRequest, 'requestId'>): Promise<NotificationsResult> {
  const socket = state.socket
  if (!socket)
    return Promise.reject(new Error('Not connected to the game server'))

  const requestId = `r${++state.nextRequest}`
  return new Promise<NotificationsResult>((resolve, reject) => {
    const timer = setTimeout(() => {
      state.pending.delete(requestId)
      reject(new Error('The game server didn\'t answer in time'))
    }, REQUEST_TIMEOUT_MS)
    state.pending.set(requestId, { resolve, reject, timer })
    socket.emit(event, { requestId, ...body }, { reliable: true })
  }).then((result) => {
    setUnread(state, result.unread)
    if (result.error)
      throw new Error(result.error)
    return result
  })
}

function stateOf(game: object): ClientState {
  const registry = ((globalThis as Record<symbol, unknown>)[STATES] ??= new WeakMap()) as WeakMap<object, ClientState>
  const state = registry.get(game)
  if (state)
    return state

  const listeners = new Set<Listener>()
  const unreadListeners = new Set<(unread: number) => void>()
  const on = (listener: Listener) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }
  const created: ClientState = {
    game: game as GameLike,
    listeners,
    unreadListeners,
    pending: new Map(),
    nextRequest: 0,
    api: {
      on,
      onType: (type, listener) => on(n => n.type === type && listener(n as GameNotification<any>)),
      stored: async (options = {}) => {
        const result = await request(created, LIST_MESSAGE, options)
        return { notifications: result.notifications ?? [], unread: result.unread }
      },
      markRead: async (ids) => {
        const result = await request(created, READ_MESSAGE, ids
          ? { ids }
          : {})
        return { marked: result.marked ?? 0, unread: result.unread }
      },
      get unread() {
        return created.unread
      },
      onUnread: (listener) => {
        unreadListeners.add(listener)
        return () => void unreadListeners.delete(listener)
      },
    },
  }
  registry.set(game, created)
  return created
}

/** The notifications of a game: `notifications(game).on(n => showToast(n))` */
export function notifications(game: object): NotificationsClient {
  return stateOf(game).api
}

function isNotification(value: unknown): value is GameNotification {
  const n = value as GameNotification
  return !!n && typeof n === 'object' && typeof n.id === 'string' && typeof n.type === 'string'
}

const plugin: ClientPlugin = {
  name: 'Notifications',

  api(ctx: ClientPluginContext) {
    return stateOf(ctx.game).api
  },

  /** The game connects whenever it wants to, so the connection is looked for until it is there */
  update(_delta, ctx) {
    const state = stateOf(ctx.game)
    state.logger = ctx.logger
    const game = ctx.game as unknown as GameLike
    const socket = game.network?.socket
    if (!socket || state.socket === socket)
      return

    // Answers to requests on the connection before won't come any more
    for (const [requestId, pending] of state.pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('The connection to the game server changed'))
      state.pending.delete(requestId)
    }
    state.socket = socket

    socket.on(NOTIFICATION_MESSAGE, (data) => {
      if (!isNotification(data))
        return
      game.trigger?.(NOTIFICATION_EVENT, data)
      for (const listener of state.listeners) {
        try {
          listener(data)
        }
        catch (err) {
          ctx.logger?.error(`Notifications: a listener failed on ${data.type}: ${(err as Error)?.stack ?? err}`)
        }
      }
    })

    socket.on(UNREAD_MESSAGE, data => setUnread(state, (data as { unread?: unknown } | null)?.unread))

    socket.on(RESULT_MESSAGE, (data) => {
      const result = data as NotificationsResult | null
      const pending = result && typeof result.requestId === 'string'
        ? state.pending.get(result.requestId)
        : undefined
      if (!pending)
        return
      clearTimeout(pending.timer)
      state.pending.delete(result!.requestId)
      pending.resolve(result!)
    })
  },
}

export default plugin
