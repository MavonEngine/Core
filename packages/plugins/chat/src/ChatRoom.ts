import type { ChatMessage, ChatSender } from './protocol.js'

export interface ChatOptions {
  /** Longest message that is passed on, in characters. Default 200 */
  maxLength?: number
  /** How many messages a player may send within how many seconds. Default 5 within 10 */
  rateLimit?: { messages?: number, perSeconds?: number }
  /** How many recent messages a client is sent when it connects. Default 50, 0 for none */
  history?: number
  /**
   * How far a message is heard, in world units: only players this close to the sender get it.
   * Default 0, which means everyone does. With a range, no history is sent to new clients.
   */
  range?: number
  /** Say so in the chat when a player joins or leaves. Default true */
  announce?: boolean
  /** URL path of the admin API, which is guarded by the server's admin token. Default `/api/chat` */
  path?: string
}

export interface ResolvedChatOptions {
  maxLength: number
  rateLimit: { messages: number, perMs: number }
  history: number
  range: number
  announce: boolean
  path: string
}

/** Control characters, line breaks and tabs among them */
const CONTROL_CHARACTERS_RE = /\p{Cc}+/gu
const WHITESPACE_RE = /\s+/g
const TRAILING_SLASHES_RE = /\/+$/
const LEADING_SLASHES_RE = /^\/+/

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
}

function atLeastZero(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback
}

/**
 * Options from mavonengine.json, with the defaults filled in
 */
export function resolveChatOptions(options: ChatOptions = {}): ResolvedChatOptions {
  const path = `/${(typeof options.path === 'string' ? options.path : '/api/chat').replace(LEADING_SLASHES_RE, '').replace(TRAILING_SLASHES_RE, '')}`
  return {
    maxLength: Math.floor(positive(options.maxLength, 200)),
    rateLimit: {
      messages: Math.floor(positive(options.rateLimit?.messages, 5)),
      perMs: positive(options.rateLimit?.perSeconds, 10) * 1000,
    },
    history: Math.floor(atLeastZero(options.history, 50)),
    range: atLeastZero(options.range, 0),
    announce: options.announce !== false,
    path: path === '/' ? '/api/chat' : path,
  }
}

/** What became of something a player sent: a message to pass on, a notice for the sender alone, or nothing */
export type SayResult = { message: ChatMessage } | { notice: string } | { ignored: true }

export interface Mute {
  playerId: string
  /** Epoch ms the mute ends, null for one that doesn't */
  until: number | null
}

/**
 * The chat of one server, without the network: what may be said by whom, and what was said.
 * The server plugin passes messages in and sends on what comes out.
 */
export default class ChatRoom {
  private messages: ChatMessage[] = []
  private nextId = 1
  /** Until when a player is muted, Infinity for good */
  private mutes = new Map<string, number>()
  /** When each player sent its recent messages, for the rate limit */
  private sent = new Map<string, number[]>()

  constructor(readonly options: ResolvedChatOptions, private now: () => number = Date.now) {}

  /**
   * Clean up what a player typed: control characters and line breaks become spaces, runs of whitespace one space.
   * Returns undefined for anything that is no text.
   */
  static clean(text: unknown): string | undefined {
    if (typeof text !== 'string')
      return undefined
    return text.replace(CONTROL_CHARACTERS_RE, ' ').replace(WHITESPACE_RE, ' ').trim()
  }

  /**
   * A player wants to say `text`
   */
  say(sender: ChatSender, text: unknown): SayResult {
    const clean = ChatRoom.clean(text)
    if (!clean)
      return { ignored: true }

    const now = this.now()

    const mutedUntil = this.mutedUntil(sender.id)
    if (mutedUntil !== undefined) {
      return {
        notice: mutedUntil === null
          ? 'You are muted'
          : `You are muted for another ${Math.max(1, Math.ceil((mutedUntil - now) / 60_000))} min`,
      }
    }

    // Counted in characters as people see them, so an emoji is one
    if ([...clean].length > this.options.maxLength)
      return { notice: `That message is too long, the limit is ${this.options.maxLength} characters` }

    const { messages, perMs } = this.options.rateLimit
    const recent = (this.sent.get(sender.id) ?? []).filter(at => now - at < perMs)
    if (recent.length >= messages) {
      this.sent.set(sender.id, recent)
      return { notice: `You are sending messages too fast, wait ${Math.max(1, Math.ceil((recent[0] + perMs - now) / 1000))} s` }
    }
    recent.push(now)
    this.sent.set(sender.id, recent)

    return { message: this.add({ id: sender.id, name: sender.name }, clean) }
  }

  /**
   * A message of the server itself: someone joined, an announcement of an admin
   */
  system(text: string): ChatMessage {
    return this.add(null, ChatRoom.clean(text) ?? '')
  }

  private add(from: ChatSender | null, text: string): ChatMessage {
    const message: ChatMessage = { id: this.nextId++, from, text, at: this.now() }

    if (this.options.history > 0) {
      this.messages.push(message)
      if (this.messages.length > this.options.history)
        this.messages.splice(0, this.messages.length - this.options.history)
    }

    return message
  }

  /** The recent messages, oldest first */
  get history(): ChatMessage[] {
    return [...this.messages]
  }

  /**
   * Stop passing on what a player says, for `minutes` or until it is unmuted.
   * A player is known by the id of its connection, so the mute lasts as long as that connection does.
   */
  mute(playerId: string, minutes?: number): Mute {
    const until = typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? this.now() + minutes * 60_000 : Infinity
    this.mutes.set(playerId, until)
    return { playerId, until: until === Infinity ? null : until }
  }

  /** Returns whether the player was muted */
  unmute(playerId: string): boolean {
    return this.mutedUntil(playerId) !== undefined && this.mutes.delete(playerId)
  }

  /** Epoch ms the player's mute ends, null for one that doesn't end, undefined when it isn't muted */
  mutedUntil(playerId: string): number | null | undefined {
    const until = this.mutes.get(playerId)
    if (until === undefined)
      return undefined

    if (until <= this.now()) {
      this.mutes.delete(playerId)
      return undefined
    }

    return until === Infinity ? null : until
  }

  /** The mutes that are still on */
  listMutes(): Mute[] {
    return [...this.mutes.keys()].flatMap((playerId) => {
      const until = this.mutedUntil(playerId)
      return until === undefined ? [] : [{ playerId, until }]
    })
  }

  /**
   * A player left: what it sent no longer counts against anyone. Its mute is kept, though a player gets a new
   * id when it connects again, so that only matters to tools that still list it.
   */
  forget(playerId: string): void {
    this.sent.delete(playerId)
  }
}
