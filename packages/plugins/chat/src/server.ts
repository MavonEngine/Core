import type { PluginMigration, ServerPlugin, ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { Express, Request, RequestHandler, Response } from 'express'
import type { ChatOptions, Mute } from './ChatRoom.js'
import type { ChatHistory, ChatMessage, ChatNotice, ChatSend, ChatSender } from './protocol.js'
import ChatRoom, { resolveChatOptions } from './ChatRoom.js'
import { CHAT_HISTORY, CHAT_MESSAGE, CHAT_NOTICE, CHAT_SEND } from './protocol.js'

export { default as ChatRoom, resolveChatOptions } from './ChatRoom.js'
export type { ChatOptions, Mute, ResolvedChatOptions } from './ChatRoom.js'
export * from './protocol.js'

/**
 * `requireAdmin` is missing on a @mavonengine/core from before the server had an admin token, `db` and `table` on one
 * from before plugins had a database, `identity` on one from before auth plugins
 */
type Context = Pick<ServerPluginContext, 'server' | 'game' | 'logger' | 'options'> & Partial<Pick<ServerPluginContext, 'requireAdmin' | 'db' | 'table' | 'identity'>>

/** The parts of a connection the chat uses, which is what geckos.io's ServerChannel has */
interface Channel {
  id?: string
  /** Who the server's auth plugin let it in as, read through `ctx.identity()` */
  userData?: unknown
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

/** What an interceptor is told about a message a player wants to send */
export interface OutgoingChat {
  from: ChatSender
  /** Cleaned up, within the length limit */
  text: string
}

export interface ChatInterceptTools {
  /** Tell the sender something that nobody else sees, like the answer to a command */
  reply(text: string): void
  /** The sender's entity in the world */
  player: unknown
}

/**
 * What an interceptor makes of a message:
 * - nothing: it goes out as it is
 * - `false`: it is dropped, and nobody is told
 * - a string: it goes out with this text instead
 * - `{ text?, to? }`: with this text, and with `to` only to these players (and its sender), like a whisper
 *   or a team chat. A message that isn't for everyone is left out of the history
 */
export type ChatInterceptResult = void | false | string | { text?: string, to?: string[] }

/** Called with every message a player sends, before it goes out. May change it, drop it or answer it */
export type ChatInterceptor = (message: OutgoingChat, tools: ChatInterceptTools) => ChatInterceptResult

/** Called with every message after it went out, also those of the server itself (`from` is null) */
export type ChatListener = (message: ChatMessage, info: { recipients: string[] }) => void

interface ChatState {
  /** Set while the plugin runs on the server */
  room?: ChatRoom
  ctx?: Context
  /** What each announced player was last called, so a goodbye can still name someone whose entity is gone */
  names: Map<string, string>
  /** Players whose "joined" is still to be said, with when they connected */
  joining: Map<string, number>
  interceptors: Set<ChatInterceptor>
  listeners: Set<ChatListener>
  hooks?: ChatHooks
  /** Mutes being loaded or saved, one after the other. Waited for before the database closes */
  writes: Promise<void>
}

/**
 * The chat of each server. Kept on the global object under a registered symbol, not in this module: the game
 * imports this package by name and the engine loads the plugin by path, which can be two copies of the module.
 */
const STATES = Symbol.for('mavonengine.chat.servers')

function stateOf(server: object): ChatState {
  const registry = ((globalThis as Record<symbol, unknown>)[STATES] ??= new WeakMap()) as WeakMap<object, ChatState>
  let state = registry.get(server)
  if (!state) {
    state = {
      names: new Map(),
      joining: new Map(),
      interceptors: new Set(),
      listeners: new Set(),
      writes: Promise.resolve(),
    }
    registry.set(server, state)
  }
  return state
}

/**
 * What a game does with the chat on its server. Get it with `chat(server)`, also before the server starts:
 * what is registered then applies once the plugin runs.
 */
export interface ChatHooks {
  /**
   * Have a say in every message a player sends, before it goes out: change it, drop it, answer the sender or
   * send it to some players only. Interceptors run in the order they were added, after the chat's own checks
   * (mute, length, rate). Returns a function that removes it again.
   *
   *   chat(server).intercept((message, tools) => {
   *     if (message.text === '/roll') {
   *       tools.reply(`You rolled ${1 + Math.floor(Math.random() * 6)}`)
   *       return false
   *     }
   *   })
   */
  intercept(interceptor: ChatInterceptor): () => void
  /** Be told every message after it went out, e.g. to log it. Returns a function that stops that */
  onMessage(listener: ChatListener): () => void
  /** Say something to everyone as the server. Undefined while the plugin isn't running */
  announce(text: string): ChatMessage | undefined
  /**
   * Stop passing on what a player says, for `minutes` or until it is unmuted. `playerId` is the id of a connected
   * player, or an account id. A player with an account, from the server's auth plugin, is muted on the account: that
   * holds when it connects again, and is kept in the database when the server has one. Without, the mute is on the
   * connection and ends with it. Undefined while the plugin isn't running
   */
  mute(playerId: string, minutes?: number): Mute | undefined
  /** Returns whether the player was muted. Takes the id of a connected player or an account id, like `mute()` */
  unmute(playerId: string): boolean
  /** The chat itself, while the plugin runs: its history, mutes and options */
  readonly room: ChatRoom | undefined
}

/**
 * The chat of a game server, for the game's own code:
 *
 *   import { chat } from '@mavonengine/chat/server'
 *
 *   chat(server).onMessage(message => logger.info(`${message.from?.name ?? 'server'}: ${message.text}`))
 */
export function chat(server: object): ChatHooks {
  const state = stateOf(server)

  state.hooks ??= {
    intercept(interceptor) {
      state.interceptors.add(interceptor)
      return () => void state.interceptors.delete(interceptor)
    },
    onMessage(listener) {
      state.listeners.add(listener)
      return () => void state.listeners.delete(listener)
    },
    announce: text => state.ctx && announce(state.ctx, text),
    mute: (playerId, minutes) => state.ctx && muteAs(state.ctx, playerId, minutes),
    unmute: playerId => !!state.ctx && unmuteAs(state.ctx, playerId),
    get room() {
      return state.room
    },
  }

  return state.hooks
}

/** The chat of the server a plugin context belongs to, once the plugin was set up */
export function chatRoom(ctx: Pick<ServerPluginContext, 'server'>): ChatRoom | undefined {
  return stateOf(ctx.server).room
}

function connections(ctx: Context): Channel[] {
  const all = (ctx.server as unknown as { gameSocket: { connectionsManager: { connections: Map<string, { channel: Channel }> } } }).gameSocket.connectionsManager.connections
  return Array.from(all.values(), connection => connection.channel)
}

/** Whether the server checks who connects with an auth plugin, so that players have accounts */
function hasAuth(ctx: Context): boolean {
  return typeof (ctx.server as { authProvider?: unknown }).authProvider === 'string'
}

/** The account of a connection, from the server's auth plugin. Undefined without one, or on a core without identities */
function accountOf(ctx: Context, channel: Channel): string | undefined {
  return ctx.identity?.(channel as unknown as Parameters<NonNullable<Context['identity']>>[0])?.id
}

/**
 * What a mute of `playerId` is on: the account of a connected player that has one, else its connection. An id that
 * isn't connected is taken for an account id when the server has an auth plugin
 */
function muteTarget(ctx: Context, playerId: string): { key: string, kind: Mute['kind'] } {
  const channel = connections(ctx).find(connection => connection.id === playerId)
  const account = channel && accountOf(ctx, channel)
  if (account)
    return { key: account, kind: 'account' }
  return {
    key: playerId,
    kind: channel || !hasAuth(ctx)
      ? 'connection'
      : 'account',
  }
}

const MUTES_TABLE = 'mutes'

/** The chat's tables: `chat_mutes`, the mutes on accounts, which outlast a restart */
export const migrations: Record<string, PluginMigration> = {
  '001_init': {
    async up(db, { table }) {
      await db.schema.createTable(table(MUTES_TABLE))
        .addColumn('account_id', 'varchar(255)', c => c.primaryKey())
        // Epoch ms, null for a mute that doesn't end
        .addColumn('until', 'bigint')
        .addColumn('created_at', 'varchar(32)', c => c.notNull())
        .execute()
    },
  },
}

/** Run `write` after the ones before it, logging rather than throwing when it fails */
function queue(ctx: Context, write: () => Promise<void>) {
  const state = stateOf(ctx.server)
  state.writes = state.writes.then(write).catch((err: unknown) => {
    ctx.logger?.error(`Chat: could not save the mutes: ${(err as Error)?.message ?? err}`)
  })
}

/** Keep a mute on an account in the database, when the server has one: connection mutes end with it anyway */
function saveMute(ctx: Context, mute: Mute) {
  const { db, table } = ctx
  if (!db || !table || mute.kind !== 'account')
    return
  queue(ctx, () => db.transaction().execute(async (trx) => {
    await trx.deleteFrom(table(MUTES_TABLE)).where('account_id', '=', mute.playerId).execute()
    await trx.insertInto(table(MUTES_TABLE)).values({
      account_id: mute.playerId,
      until: mute.until,
      created_at: new Date().toISOString(),
    }).execute()
  }))
}

function dropMute(ctx: Context, key: string) {
  const { db, table } = ctx
  if (!db || !table)
    return
  queue(ctx, async () => {
    await db.deleteFrom(table(MUTES_TABLE)).where('account_id', '=', key).execute()
  })
}

/** Put the saved mutes back into the room, and forget those that ended */
function loadMutes(ctx: Context, room: ChatRoom) {
  const { db, table } = ctx
  if (!db || !table)
    return
  queue(ctx, async () => {
    const now = Date.now()
    await db.deleteFrom(table(MUTES_TABLE)).where('until', 'is not', null).where('until', '<=', now).execute()
    const rows = await db.selectFrom(table(MUTES_TABLE)).select(['account_id', 'until']).execute()
    room.restore(rows.map(row => ({
      playerId: String(row.account_id),
      kind: 'account',
      until: row.until === null
        ? null
        : Number(row.until),
    })))
    if (rows.length) {
      ctx.logger?.info(`Chat: ${rows.length} player${rows.length === 1
        ? ' is'
        : 's are'} still muted`)
    }
  })
}

function muteAs(ctx: Context, playerId: string, minutes?: number): Mute | undefined {
  const room = stateOf(ctx.server).room
  if (!room)
    return undefined
  const { key, kind } = muteTarget(ctx, playerId)
  const mute = room.mute(key, minutes, kind)
  saveMute(ctx, mute)
  return mute
}

function unmuteAs(ctx: Context, playerId: string): boolean {
  const room = stateOf(ctx.server).room
  if (!room)
    return false
  const { key } = muteTarget(ctx, playerId)
  // Also the id as given, for a connection mute of a player that has since been let in with an account
  const unmuted = room.unmute(key) || (key !== playerId && room.unmute(playerId))
  dropMute(ctx, key)
  return unmuted
}

/** Wait until the mutes are loaded and saved, e.g. in a test or before stopping the server some other way */
export function mutesSaved(server: object): Promise<void> {
  return stateOf(server).writes
}

function entityOf(ctx: Context, id: string | undefined) {
  return id === undefined
    ? undefined
    : ctx.game.world.entities.items.get(id) as { id: string, position?: Position, displayName?: string, name?: unknown } | undefined
}

/** What a player is called: the display name the game gave it, else its `name`, else its id */
function nameOf(entity: NonNullable<ReturnType<typeof entityOf>>): string {
  if (entity.displayName && entity.displayName !== entity.id)
    return entity.displayName
  return typeof entity.name === 'string' && entity.name
    ? entity.name
    : entity.id
}

/**
 * Send a message to everyone who should get it, and tell the game's listeners.
 * With a range, only to those close enough to `around`; with `to`, only to those players and the sender.
 * Connections without a player, like the editor, get everything that is meant for everyone.
 */
function deliver(ctx: Context, message: ChatMessage, { around, to }: { around?: Position, to?: string[] } = {}) {
  const state = stateOf(ctx.server)
  const range = state.room?.options.range ?? 0
  const only = to && new Set([
    ...to,
    ...(message.from
      ? [message.from.id]
      : []),
  ])
  const recipients: string[] = []

  for (const channel of connections(ctx)) {
    if (only) {
      if (channel.id === undefined || !only.has(channel.id))
        continue
    }
    else {
      const position = range > 0 && around
        ? entityOf(ctx, channel.id)?.position
        : undefined
      if (position && position.distanceTo(around!) > range)
        continue
    }

    channel.emit(CHAT_MESSAGE, message, RELIABLE)
    if (channel.id !== undefined)
      recipients.push(channel.id)
  }

  for (const listener of state.listeners) {
    try {
      listener(message, { recipients })
    }
    catch (err) {
      ctx.logger?.error(`Chat: a message listener threw: ${(err as Error)?.stack ?? err}`)
    }
  }
}

/** Say something in the chat as the server, to everyone */
export function announce(ctx: Context, text: string): ChatMessage | undefined {
  const room = chatRoom(ctx)
  if (!room)
    return undefined

  const message = room.system(text)
  deliver(ctx, message)
  return message
}

/**
 * A player sent something: the chat's own checks first, then the game's interceptors, then out it goes
 */
function receive(ctx: Context, connection: Channel, id: string, data: unknown) {
  const state = stateOf(ctx.server)
  // Only players talk: the editor's connection has no entity
  const entity = entityOf(ctx, id)
  if (!state.room || !entity)
    return

  const sender: ChatSender = {
    id,
    name: nameOf(entity),
  }
  if (state.names.has(id))
    state.names.set(id, sender.name)

  const notice = (text: string) => connection.emit(CHAT_NOTICE, { text } satisfies ChatNotice, RELIABLE)

  // A mute is on the player's account when it has one, so connecting again doesn't lift it
  const checked = state.room.check(sender, (data as Partial<ChatSend> | null)?.text, accountOf(ctx, connection) ?? id)
  if ('notice' in checked)
    notice(checked.notice)
  if (!('text' in checked))
    return

  let { text } = checked
  let to: string[] | undefined
  const tools: ChatInterceptTools = { reply: notice, player: entity }

  for (const intercept of state.interceptors) {
    let result: ChatInterceptResult
    try {
      result = intercept({
        from: { ...sender },
        text,
      }, tools)
    }
    catch (err) {
      // A broken interceptor must not take the chat down, nor let through what it may have meant to stop
      ctx.logger?.error(`Chat: an interceptor threw, the message was dropped: ${(err as Error)?.stack ?? err}`)
      return
    }

    if (result === false)
      return

    const changed = typeof result === 'string'
      ? result
      : result?.text
    if (changed !== undefined) {
      const clean = ChatRoom.clean(changed)
      if (!clean)
        return
      text = clean
    }
    if (result && typeof result === 'object' && Array.isArray(result.to))
      to = result.to.filter(player => typeof player === 'string')
  }

  // What isn't for everyone stays out of the history new players are sent
  deliver(ctx, state.room.post(sender, text, !to), { around: entity.position, to })
}

/** Registered symbol core reads a route's description from. Written here so the plugin runs on a core without it too */
const ROUTE_DOC = Symbol.for('mavonengine.routeDoc')

/** Says what a route does, for the endpoint lists of the dashboard and the editor. Does nothing to the request */
function describe(doc: { summary: string, description?: string, params?: Record<string, string>, response?: string }): RequestHandler {
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
        const parsed: unknown = body
          ? JSON.parse(body)
          : {}
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

/** What guards the admin API on a core without an admin token of its own: only this machine gets in */
const localhostOnly: RequestHandler = (req, res, next) => {
  if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) {
    res.status(403).json({ error: 'The chat admin API is only available from localhost: this @mavonengine/core has no admin token' })
    return
  }

  next()
}

/**
 * The admin API: read the chat, announce something, mute and unmute players.
 * Guarded by the server's admin token, like every other admin route of the server: the chat has no token of its own.
 */
export function mountChatApi(app: Express, ctx: Context, room: ChatRoom) {
  const { path } = room.options
  // Who it lets through is listed with the routes by the guard itself
  const admin = ctx.requireAdmin ?? localhostOnly

  const body = (handle: (body: Record<string, unknown>, req: Request, res: Response) => void) => (req: Request, res: Response) => {
    readJson(req).then(parsed => handle(parsed, req, res), (err: Error) => res.status(400).json({ error: err.message }))
  }

  app.get(`${path}/messages`, describe({
    summary: 'The recent chat messages',
    response: '`{ messages }`, oldest first, as many as the `history` option keeps',
  }), admin, (_req, res) => {
    res.json({ messages: room.history })
  })

  app.post(`${path}/messages`, describe({
    summary: 'Announce something in the chat',
    description: 'Send `{ "text": "..." }`. Everyone gets it as a message of the server.',
    response: '`{ message }`, or 400 without a text',
  }), admin, body((parsed, _req, res) => {
    const text = ChatRoom.clean(parsed.text)
    if (!text) {
      res.status(400).json({ error: 'Expected { text }' })
      return
    }

    res.json({
      message: announce(ctx, text),
    })
  }))

  app.get(`${path}/mutes`, describe({
    summary: 'The players that are muted',
    response: '`{ mutes }`, each with `playerId`, `kind` (`account`, which holds when the player connects again, or `connection`, which ends with it) and `until` (epoch ms, null for a mute that doesn\'t end)',
  }), admin, (_req, res) => {
    res.json({
      mutes: room.listMutes(),
    })
  })

  app.post(`${path}/mutes`, describe({
    summary: 'Mute a player',
    description: 'Send `{ "playerId": "...", "minutes": 10 }` with the id of a connected player or an account id. Without `minutes` the mute lasts until it is lifted. A player with an account, from the server\'s auth plugin, is muted on the account: it stays muted when it connects again, and after a restart when the server has a database. Without an auth plugin, a player is known by the id of its connection, so it is unmuted when it connects again.',
    response: '`{ mute }`, or 400 without a player id',
  }), admin, body((parsed, _req, res) => {
    if (typeof parsed.playerId !== 'string' || !parsed.playerId) {
      res.status(400).json({ error: 'Expected { playerId, minutes? }' })
      return
    }

    const mute = muteAs(ctx, parsed.playerId, typeof parsed.minutes === 'number'
      ? parsed.minutes
      : undefined)!
    ctx.logger?.info(`Chat: muted ${mute.kind === 'account'
      ? 'account'
      : 'connection'} ${mute.playerId}${mute.until === null
      ? ''
      : ` until ${new Date(mute.until).toISOString()}`}`)
    res.json({ mute })
  }))

  app.delete(`${path}/mutes/:playerId`, describe({
    summary: 'Unmute a player',
    params: { playerId: 'Id of a connected player, or an account id' },
    response: '`{ unmuted }`, false when the player was not muted',
  }), admin, (req, res) => {
    res.json({
      unmuted: unmuteAs(ctx, String(req.params.playerId)),
    })
  })
}

/**
 * Text chat for the players of a game server.
 *
 * Players send `chat:send`, everyone (or everyone in range) gets `chat:message`. The server cleans up what is
 * said, limits how fast a player may talk and how long a message may be, and keeps muted players quiet.
 * The game has its say through `chat(server)`.
 */
const plugin: ServerPlugin = {
  name: 'Chat',
  migrations,

  setup(ctx) {
    const state = stateOf(ctx.server)
    state.room = new ChatRoom(resolveChatOptions(ctx.options as ChatOptions))
    state.ctx = ctx
    if (!hasAuth(ctx))
      ctx.logger?.info('Chat: the server has no auth plugin, so players are known by their connection and a mute ends when the player connects again')
    loadMutes(ctx, state.room)
  },

  http(app, ctx) {
    const room = chatRoom(ctx)
    if (room)
      mountChatApi(app, ctx, room)
  },

  onConnection(channel, _client, ctx) {
    const state = stateOf(ctx.server)
    const connection = channel as unknown as Channel
    const id = connection.id
    if (!state.room || id === undefined)
      return

    const { room } = state

    // Not with a range: it would tell a new player what was said out of its earshot
    if (room.options.history > 0 && room.options.range === 0)
      connection.emit(CHAT_HISTORY, { messages: room.history } satisfies ChatHistory, RELIABLE)

    connection.on(CHAT_SEND, data => receive(ctx, connection, id, data))

    // Said on a later tick: a game usually names a player just after it connected
    if (room.options.announce && entityOf(ctx, id))
      state.joining.set(id, Date.now())
  },

  tick(_delta, ctx) {
    const state = stateOf(ctx.server)
    if (!state.joining.size)
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
    const state = stateOf(ctx.server)
    const id = (channel as unknown as Channel).id
    if (!state.room || id === undefined)
      return

    state.room.forget(id)
    // Gone before it was said to have joined: nothing to take back
    state.joining.delete(id)

    const name = state.names.get(id)
    state.names.delete(id)
    if (name !== undefined)
      announce(ctx, `${name} left`)
  },

  /** The game's interceptors and listeners stay: they belong to the game, not to this run of the plugin */
  destroy(ctx) {
    const state = stateOf(ctx.server)
    // The server closes the database once this settled, so the last mutes are still saved
    const writes = state.writes
    state.room = undefined
    state.ctx = undefined
    state.names.clear()
    state.joining.clear()
    return writes
  },
}

export default plugin
