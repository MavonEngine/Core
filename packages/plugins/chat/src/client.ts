import type { ClientPlugin, ClientPluginContext } from '@mavonengine/core/Plugins/types'
import type { ChatPosition } from './ChatBox.js'
import type { ChatHistory, ChatMessage, ChatNotice, ChatSend } from './protocol.js'
import ChatBox from './ChatBox.js'
import { CHAT_HISTORY, CHAT_MESSAGE, CHAT_NOTICE, CHAT_SEND } from './protocol.js'

export { default as ChatBox, nameColor } from './ChatBox.js'
export type { ChatBoxOptions, ChatPosition } from './ChatBox.js'
export * from './protocol.js'

export interface ChatClientOptions {
  /** How many lines the log keeps. Default 100 */
  maxMessages?: number
  /** Longest text the input takes. Keep it at the server's `maxLength`. Default 200 */
  maxLength?: number
  /** Key that starts typing. Default `Enter` */
  openKey?: string
  /** Shown in the empty input */
  placeholder?: string
  /** Corner of the page the chat sits in: `bottom-left` (default), `bottom-right`, `top-left` or `top-right` */
  position?: ChatPosition
  /** Don't put the chat on screen: the game shows the messages itself, see `chat(game)` */
  ui?: boolean
}

/** Name of the event the game is told every chat message with: `game.on(CHAT_EVENT, (message: ChatMessage) => …)` */
export const CHAT_EVENT = CHAT_MESSAGE

/** The parts of the game's connection the chat uses, which is what geckos.io's ClientChannel has */
interface Socket {
  on(event: string, callback: (data: unknown) => void): void
  emit(event: string, data: unknown, options?: { reliable?: boolean }): void
}

/** The parts of the game the chat uses */
interface GameLike {
  trigger?(name: string, event?: unknown): void
  network?: { socket?: Socket }
}

type Listener<T> = (value: T) => void

interface ChatClientState {
  box?: ChatBox
  socket?: Socket
  messages: Set<Listener<ChatMessage>>
  notices: Set<Listener<string>>
  histories: Set<Listener<ChatMessage[]>>
  api?: ChatClient
}

/**
 * The chat of each running game. Kept on the global object under a registered symbol, not in this module,
 * so the game and the plugin share it even when the bundler ends up with two copies of the module.
 */
const STATES = Symbol.for('mavonengine.chat.clients')

function stateOf(game: object): ChatClientState {
  const registry = ((globalThis as Record<symbol, unknown>)[STATES] ??= new WeakMap()) as WeakMap<object, ChatClientState>
  let state = registry.get(game)
  if (!state) {
    state = { messages: new Set(), notices: new Set(), histories: new Set() }
    registry.set(game, state)
  }
  return state
}

/**
 * What a game does with the chat in the browser. Get it with `chat(game)`, also before the game has connected.
 */
export interface ChatClient {
  /** Be told every message as it is said, e.g. to show a bubble over the player. Returns a function that stops that */
  onMessage(listener: Listener<ChatMessage>): () => void
  /** Be told what the server says to this player alone, like "you are sending messages too fast" */
  onNotice(listener: Listener<string>): () => void
  /** Be told the recent messages the server sends when the game connects */
  onHistory(listener: Listener<ChatMessage[]>): () => void
  /** Say something, as if the player had typed it. Returns false while the game isn't connected */
  send(text: string): boolean
  /** The chat box on screen, to add lines of your own, hide it or move it. Undefined with `ui: false` */
  readonly box: ChatBox | undefined
}

/**
 * The chat of a game, for the game's own code:
 *
 *   import { chat } from '@mavonengine/chat/client'
 *
 *   chat(game).onMessage(message => console.log(message.from?.name, message.text))
 */
export function chat(game: object): ChatClient {
  const state = stateOf(game)
  const subscribe = <T>(listeners: Set<Listener<T>>) => (listener: Listener<T>) => {
    listeners.add(listener)
    return () => void listeners.delete(listener)
  }

  state.api ??= {
    onMessage: subscribe(state.messages),
    onNotice: subscribe(state.notices),
    onHistory: subscribe(state.histories),
    send(text) {
      if (!state.socket)
        return false
      state.socket.emit(CHAT_SEND, { text } satisfies ChatSend, { reliable: true })
      return true
    },
    get box() {
      return state.box
    },
  }

  return state.api
}

/**
 * Say something in the chat, as if the player had typed it. Returns false while the game isn't connected.
 * Same as `chat(game).send(message)`.
 */
export function sendChat(ctx: Pick<ClientPluginContext, 'game'>, message: string): boolean {
  return chat(ctx.game).send(message)
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/** A listener of the game that throws must not stop the others, nor the chat */
function tell<T>(listeners: Set<Listener<T>>, value: T, ctx: ClientPluginContext) {
  for (const listener of listeners) {
    try {
      listener(value)
    }
    catch (err) {
      ctx.logger?.error(`Chat: a listener threw: ${(err as Error)?.stack ?? err}`)
    }
  }
}

/**
 * Text chat between the players of a game.
 *
 * Puts a chat box in a corner of the page and passes what is typed there to the server over the game's
 * connection. The game listens in and talks through `chat(game)`, and gets every message, notice and history
 * as a `chat:message`, `chat:notice` and `chat:history` event as well.
 */
const plugin: ClientPlugin = {
  name: 'Chat',

  setup(ctx) {
    const options = ctx.options as ChatClientOptions
    const state = stateOf(ctx.game)

    if (options.ui === false || typeof document === 'undefined')
      return

    state.box = new ChatBox({
      send: message => void chat(ctx.game).send(message),
      maxMessages: number(options.maxMessages),
      maxLength: number(options.maxLength),
      openKey: text(options.openKey),
      placeholder: text(options.placeholder),
      position: text(options.position) as ChatPosition | undefined,
    })
  },

  /** The game connects whenever it wants to, so the connection is looked for until it is there */
  update(_delta, ctx) {
    const state = stateOf(ctx.game)
    const game = ctx.game as unknown as GameLike
    const socket = game.network?.socket
    if (!socket || state.socket === socket)
      return

    state.socket = socket

    socket.on(CHAT_MESSAGE, (data) => {
      const message = data as ChatMessage
      state.box?.add(message)
      game.trigger?.(CHAT_EVENT, message)
      tell(state.messages, message, ctx)
    })

    socket.on(CHAT_HISTORY, (data) => {
      // Shown, but not told as messages: nobody is saying these right now
      const messages = (data as ChatHistory).messages ?? []
      for (const message of messages)
        state.box?.add(message)
      game.trigger?.(CHAT_HISTORY, messages)
      tell(state.histories, messages, ctx)
    })

    socket.on(CHAT_NOTICE, (data) => {
      const notice = (data as ChatNotice).text
      state.box?.notice(notice)
      game.trigger?.(CHAT_NOTICE, notice)
      tell(state.notices, notice, ctx)
    })
  },

  /** The editor takes the whole page, and whoever runs it is no player */
  editor(ctx) {
    stateOf(ctx.game).box?.hide()
  },
}

export default plugin
