/**
 * What the chat's client and server say to each other, over the game's own connection.
 * Every message is sent reliably: a chat line that is lost is a conversation that makes no sense.
 */

/** Client → server: `{ text }`, something the player wants to say */
export const CHAT_SEND = 'chat:send'
/** Server → client: a `ChatMessage` for the chat log */
export const CHAT_MESSAGE = 'chat:message'
/** Server → client: `{ messages }`, the recent messages, sent once when a client connects */
export const CHAT_HISTORY = 'chat:history'
/** Server → client: `{ text }` for this client only, when what it sent was not passed on */
export const CHAT_NOTICE = 'chat:notice'

export interface ChatSender {
  /** Id of the player's entity, which is the id of its connection */
  id: string
  name: string
}

export interface ChatMessage {
  /** Goes up with every message of a server run */
  id: number
  /** Who said it, null for a message of the server itself (someone joined, an announcement) */
  from: ChatSender | null
  text: string
  /** Epoch ms on the server */
  at: number
}

export interface ChatSend {
  text: string
}

export interface ChatHistory {
  messages: ChatMessage[]
}

export interface ChatNotice {
  text: string
}
