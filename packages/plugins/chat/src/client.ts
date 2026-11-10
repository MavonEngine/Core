import type { ClientPlugin, ClientPluginContext } from '@mavonengine/core/Plugins/types'
import type { ChatHistory, ChatMessage, ChatNotice, ChatSend } from './protocol.js'
import ChatBox from './ChatBox.js'
import { CHAT_HISTORY, CHAT_MESSAGE, CHAT_NOTICE, CHAT_SEND } from './protocol.js'

export { default as ChatBox, nameColor } from './ChatBox.js'
export type { ChatBoxOptions } from './ChatBox.js'
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
  /** Don't put the chat on screen: the game shows the messages itself, from the `chat:message` event */
  ui?: boolean
}

/** Name of the event the game is told every chat message with: `game.on(CHAT_EVENT, (message: ChatMessage) => …)` */
export const CHAT_EVENT = CHAT_MESSAGE

/** The parts of the game's connection the chat uses, which is what geckos.io's ClientChannel has */
interface Socket {
  on(event: string, callback: (data: unknown) => void): void
  emit(event: string, data: unknown, options?: { reliable?: boolean }): void
}

interface ChatClient {
  box?: ChatBox
  socket?: Socket
}

/** The chat of each running game: the plugin object itself is shared by all of them */
const clients = new WeakMap<object, ChatClient>()

function socketOf(ctx: ClientPluginContext): Socket | undefined {
  return (ctx.game as unknown as { network?: { socket?: Socket } }).network?.socket
}

function number(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined
}

/**
 * Say something in the chat, as if the player had typed it. Returns false while the game isn't connected.
 */
export function sendChat(ctx: Pick<ClientPluginContext, 'game'>, message: string): boolean {
  const socket = clients.get(ctx.game)?.socket
  if (!socket)
    return false

  socket.emit(CHAT_SEND, { text: message } satisfies ChatSend, { reliable: true })
  return true
}

/**
 * Text chat between the players of a game.
 *
 * Puts a chat box in the bottom left corner and passes what is typed there to the server over the game's
 * connection. Every message also reaches the game as a `chat:message` event, e.g. to show a bubble over a player.
 */
const plugin: ClientPlugin = {
  name: 'Chat',

  setup(ctx) {
    const options = ctx.options as ChatClientOptions
    const client: ChatClient = {}
    clients.set(ctx.game, client)

    if (options.ui === false || typeof document === 'undefined')
      return

    client.box = new ChatBox({
      send: message => void sendChat(ctx, message),
      maxMessages: number(options.maxMessages),
      maxLength: number(options.maxLength),
      openKey: text(options.openKey),
      placeholder: text(options.placeholder),
    })
  },

  /** The game connects whenever it wants to, so the connection is looked for until it is there */
  update(_delta, ctx) {
    const client = clients.get(ctx.game)
    const socket = socketOf(ctx)
    if (!client || !socket || client.socket === socket)
      return

    client.socket = socket

    const show = (message: ChatMessage) => {
      client.box?.add(message)
      ctx.game.trigger(CHAT_EVENT, message)
    }

    socket.on(CHAT_MESSAGE, data => show(data as ChatMessage))
    socket.on(CHAT_HISTORY, (data) => {
      // Shown, but not told to the game: nobody is saying these right now
      for (const message of (data as ChatHistory).messages ?? [])
        client.box?.add(message)
    })
    socket.on(CHAT_NOTICE, data => client.box?.notice((data as ChatNotice).text))
  },

  /** The editor takes the whole page, and whoever runs it is no player */
  editor(ctx) {
    clients.get(ctx.game)?.box?.hide()
  },
}

export default plugin
