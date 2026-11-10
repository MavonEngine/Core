import type { ServerPlugin, ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { Express, NextFunction, Request, RequestHandler, Response } from 'express'
import type { ChatOptions } from './ChatRoom.js'
import type { ChatHistory, ChatMessage, ChatNotice, ChatSend } from './protocol.js'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import process from 'node:process'
import ChatRoom, { resolveChatOptions } from './ChatRoom.js'
import { CHAT_HISTORY, CHAT_MESSAGE, CHAT_NOTICE, CHAT_SEND } from './protocol.js'

export { default as ChatRoom, resolveChatOptions } from './ChatRoom.js'
export type { ChatOptions, Mute, ResolvedChatOptions } from './ChatRoom.js'
export * from './protocol.js'

type Context = Pick<ServerPluginContext, 'server' | 'game' | 'logger' | 'options'>

/** The parts of a connection the chat uses, which is what geckos.io's ServerChannel has */
interface Channel {
  id?: string
  emit(event: string, data: unknown, options?: { reliable?: boolean }): void
  on(event: string, callback: (data: unknown) => void): void
}

interface Position {
  distanceTo(other: Position): number
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const MAX_BODY_BYTES = 4096
const RELIABLE = { reliable: true }

/** How long a new player's "joined" waits for the game to give it a name, before its id is used */
export const JOIN_NAME_WAIT_MS = 2000

interface ChatState {
  room: ChatRoom
  /** What each announced player was last called, so a goodbye can still name someone whose entity is gone */
  names: Map<string, string>
  /** Players whose "joined" is still to be said, with when they connected */
  joining: Map<string, number>
}

/** The chat of each running server: the plugin object itself is shared by all of them */
const states = new WeakMap<object, ChatState>()

/** The chat of the server a plugin context belongs to, once the plugin was set up */
export function chatRoom(ctx: Pick<ServerPluginContext, 'server'>): ChatRoom | undefined {
  return states.get(ctx.server)?.room
}

function connections(ctx: Context): Channel[] {
  const all = (ctx.server as unknown as { gameSocket: { connectionsManager: { connections: Map<string, { channel: Channel }> } } }).gameSocket.connectionsManager.connections
  return Array.from(all.values(), connection => connection.channel)
}

function entityOf(ctx: Context, id: string | undefined) {
  return id === undefined ? undefined : ctx.game.world.entities.items.get(id) as { id: string, position?: Position, displayName?: string, name?: unknown } | undefined
}

/** What a player is called: the display name the game gave it, else its `name`, else its id */
function nameOf(entity: NonNullable<ReturnType<typeof entityOf>>): string {
  if (entity.displayName && entity.displayName !== entity.id)
    return entity.displayName
  return typeof entity.name === 'string' && entity.name ? entity.name : entity.id
}

/**
 * Send a message to everyone who should get it: with a range, only to those close enough to `around`.
 * Connections without a player, like the editor, get everything.
 */
function broadcast(ctx: Context, room: ChatRoom, message: ChatMessage, around?: Position) {
  const { range } = room.options

  for (const channel of connections(ctx)) {
    const position = range > 0 && around ? entityOf(ctx, channel.id)?.position : undefined
    if (position && position.distanceTo(around!) > range)
      continue

    channel.emit(CHAT_MESSAGE, message, RELIABLE)
  }
}

/** Say something in the chat as the server, to everyone */
export function announce(ctx: Context, text: string): ChatMessage | undefined {
  const room = chatRoom(ctx)
  if (!room)
    return undefined

  const message = room.system(text)
  broadcast(ctx, room, message)
  return message
}

function safeEqual(a: string, b: string) {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/** Registered symbol core reads a route's description from. Written here so the plugin runs on a core without it too */
const ROUTE_DOC = Symbol.for('mavonengine.routeDoc')

/** Says what a route does, for the endpoint lists of the dashboard and the editor. Does nothing to the request */
function describe(doc: { summary: string, description?: string, params?: Record<string, string>, response?: string, auth?: string }): RequestHandler {
  const handler: RequestHandler = (_req, _res, next) => next()
  ;(handler as unknown as Record<symbol, unknown>)[ROUTE_DOC] = doc
  return handler
}

function readJson(req: Request): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        reject(new Error('Body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        const parsed: unknown = body ? JSON.parse(body) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('not an object')
        resolve(parsed as Record<string, unknown>)
      }
      catch {
        reject(new Error('Expected a JSON object'))
      }
    })
    req.on('error', reject)
  })
}

/**
 * The admin API: read the chat, announce something, mute and unmute players.
 * With an admin token it wants that token, without one it only answers requests from localhost.
 */
export function mountChatApi(app: Express, ctx: Context, room: ChatRoom) {
  const { path, adminToken } = room.options
  const auth = adminToken
    ? 'The admin token as `Authorization: Bearer <token>`'
    : 'Requests from localhost only. Set `adminToken` in the plugin\'s options, or MAVONENGINE_CHAT_ADMIN_TOKEN, to use it from elsewhere'

  const admin = (req: Request, res: Response, next: NextFunction) => {
    if (adminToken) {
      const header = req.headers.authorization
      if (!header?.startsWith('Bearer ') || !safeEqual(header.slice(7), adminToken)) {
        res.status(401).json({ error: 'Invalid admin token' })
        return
      }
    }
    else if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) {
      res.status(403).json({ error: 'The chat admin API is only available from localhost unless an admin token is configured' })
      return
    }

    next()
  }

  const body = (handle: (body: Record<string, unknown>, req: Request, res: Response) => void) => (req: Request, res: Response) => {
    readJson(req).then(parsed => handle(parsed, req, res), (err: Error) => res.status(400).json({ error: err.message }))
  }

  app.get(`${path}/messages`, describe({
    summary: 'The recent chat messages',
    response: '`{ messages }`, oldest first, as many as the `history` option keeps',
    auth,
  }), admin, (_req, res) => {
    res.json({ messages: room.history })
  })

  app.post(`${path}/messages`, describe({
    summary: 'Announce something in the chat',
    description: 'Send `{ "text": "..." }`. Everyone gets it as a message of the server.',
    response: '`{ message }`, or 400 without a text',
    auth,
  }), admin, body((parsed, _req, res) => {
    const text = ChatRoom.clean(parsed.text)
    if (!text) {
      res.status(400).json({ error: 'Expected { text }' })
      return
    }

    res.json({ message: announce(ctx, text) })
  }))

  app.get(`${path}/mutes`, describe({
    summary: 'The players that are muted',
    response: '`{ mutes }`, each with `playerId` and `until` (epoch ms, null for a mute that doesn\'t end)',
    auth,
  }), admin, (_req, res) => {
    res.json({ mutes: room.listMutes() })
  })

  app.post(`${path}/mutes`, describe({
    summary: 'Mute a player',
    description: 'Send `{ "playerId": "...", "minutes": 10 }`. Without `minutes` the mute lasts until it is lifted. A player is known by the id of its connection, so it is unmuted when it connects again.',
    response: '`{ mute }`, or 400 without a player id',
    auth,
  }), admin, body((parsed, _req, res) => {
    if (typeof parsed.playerId !== 'string' || !parsed.playerId) {
      res.status(400).json({ error: 'Expected { playerId, minutes? }' })
      return
    }

    const mute = room.mute(parsed.playerId, typeof parsed.minutes === 'number' ? parsed.minutes : undefined)
    ctx.logger?.info(`Chat: muted ${parsed.playerId}${mute.until === null ? '' : ` until ${new Date(mute.until).toISOString()}`}`)
    res.json({ mute })
  }))

  app.delete(`${path}/mutes/:playerId`, describe({
    summary: 'Unmute a player',
    params: { playerId: 'Id of the player' },
    response: '`{ unmuted }`, false when the player was not muted',
    auth,
  }), admin, (req, res) => {
    res.json({ unmuted: room.unmute(String(req.params.playerId)) })
  })
}

/**
 * Text chat for the players of a game server.
 *
 * Players send `chat:send`, everyone (or everyone in range) gets `chat:message`. The server cleans up what is
 * said, limits how fast a player may talk and how long a message may be, and keeps muted players quiet.
 */
const plugin: ServerPlugin = {
  name: 'Chat',

  setup(ctx) {
    states.set(ctx.server, {
      room: new ChatRoom(resolveChatOptions(ctx.options as ChatOptions, process.env)),
      names: new Map(),
      joining: new Map(),
    })
  },

  http(app, ctx) {
    const room = chatRoom(ctx)
    if (room)
      mountChatApi(app, ctx, room)
  },

  onConnection(channel, _client, ctx) {
    const state = states.get(ctx.server)
    const connection = channel as unknown as Channel
    const id = connection.id
    if (!state || id === undefined)
      return

    const { room } = state

    // Not with a range: it would tell a new player what was said out of its earshot
    if (room.options.history > 0 && room.options.range === 0)
      connection.emit(CHAT_HISTORY, { messages: room.history } satisfies ChatHistory, RELIABLE)

    connection.on(CHAT_SEND, (data) => {
      // Only players talk: the editor's connection has no entity
      const entity = entityOf(ctx, id)
      if (!entity)
        return

      const name = nameOf(entity)
      if (state.names.has(id))
        state.names.set(id, name)

      const result = room.say({ id, name }, (data as Partial<ChatSend> | null)?.text)
      if ('message' in result)
        broadcast(ctx, room, result.message, entity.position)
      else if ('notice' in result)
        connection.emit(CHAT_NOTICE, { text: result.notice } satisfies ChatNotice, RELIABLE)
    })

    // Said on a later tick: a game usually names a player just after it connected
    if (room.options.announce && entityOf(ctx, id))
      state.joining.set(id, Date.now())
  },

  tick(_delta, ctx) {
    const state = states.get(ctx.server)
    if (!state?.joining.size)
      return

    const now = Date.now()
    for (const [id, since] of state.joining) {
      const entity = entityOf(ctx, id)
      if (!entity) {
        state.joining.delete(id)
        continue
      }

      const name = nameOf(entity)
      if (name === entity.id && now - since < JOIN_NAME_WAIT_MS)
        continue

      state.joining.delete(id)
      state.names.set(id, name)
      announce(ctx, `${name} joined`)
    }
  },

  onDisconnect(channel, ctx) {
    const state = states.get(ctx.server)
    const id = (channel as unknown as Channel).id
    if (!state || id === undefined)
      return

    state.room.forget(id)
    // Gone before it was said to have joined: nothing to take back
    state.joining.delete(id)

    const name = state.names.get(id)
    state.names.delete(id)
    if (name !== undefined)
      announce(ctx, `${name} left`)
  },

  destroy(ctx) {
    states.delete(ctx.server)
  },
}

export default plugin
