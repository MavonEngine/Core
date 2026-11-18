import type { ClientPlugin, ClientPluginContext } from '@mavonengine/core/Plugins/types'
import type { GameNotification } from './protocol'
import { NOTIFICATION_EVENT, NOTIFICATION_MESSAGE } from './protocol'

export type { GameNotification } from './protocol'
export { NOTIFICATION_EVENT, NOTIFICATION_MESSAGE } from './protocol'

type Listener = (notification: GameNotification) => void

/** What the game does with notifications in the browser */
export interface NotificationsClient {
  /** Call `listener` with every notification that reaches this game. Returns a function that stops it */
  on(listener: Listener): () => void
  /** Only notifications of one type, e.g. `onType('LevelUp', n => …)` */
  onType<T = unknown>(type: string, listener: (notification: GameNotification<T>) => void): () => void
}

declare module '@mavonengine/core/Plugins/types' {
  interface ClientPluginApis {
    '@mavonengine/notifications': NotificationsClient
  }
}

/** The parts of the game's connection used, which is what geckos.io's ClientChannel has */
interface Socket {
  on(event: string, callback: (data: unknown) => void): void
}

interface GameLike {
  trigger?(name: string, event?: unknown): void
  network?: { socket?: Socket }
}

interface ClientState {
  socket?: Socket
  listeners: Set<Listener>
  api: NotificationsClient
}

/** Kept on globalThis, so the game and the plugin share it even with two copies of this module in the bundle */
const STATES = Symbol.for('mavonengine.notifications.clients')

function stateOf(game: object): ClientState {
  const registry = ((globalThis as Record<symbol, unknown>)[STATES] ??= new WeakMap()) as WeakMap<object, ClientState>
  let state = registry.get(game)
  if (!state) {
    const listeners = new Set<Listener>()
    const on = (listener: Listener) => {
      listeners.add(listener)
      return () => void listeners.delete(listener)
    }
    state = {
      listeners,
      api: {
        on,
        onType: (type, listener) => on(n => n.type === type && listener(n as GameNotification<any>)),
      },
    }
    registry.set(game, state)
  }
  return state
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
    const game = ctx.game as unknown as GameLike
    const socket = game.network?.socket
    if (!socket || state.socket === socket)
      return

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
  },
}

export default plugin
