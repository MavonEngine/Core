import type { ServerChannel } from '@geckos.io/server'
import type { Notifiable, NotificationLike, ServerPlugin, ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { GameNotification, ListRequest, NotificationsResult, ReadRequest, StoredNotification } from './protocol'
import type { Owner } from './store'
import Job from '@mavonengine/core/Queue/Job'
import { LIST_MESSAGE, MAX_READ_IDS, MAX_REQUEST_ID, NOTIFICATION_MESSAGE, READ_MESSAGE, RESULT_MESSAGE, UNREAD_MESSAGE } from './protocol'
import NotificationStore, { MAX_PAGE, migrations } from './store'

export type { GameNotification, StoredNotification } from './protocol'
export { NOTIFICATION_EVENT, NOTIFICATION_MESSAGE } from './protocol'
export { MAX_DATA_CHARS, MAX_PAGE } from './store'

export const PACKAGE = '@mavonengine/notifications'

/** What a notification's `toMail()` returns: the mail without its recipient, which the channel finds */
export interface NotificationMail {
  subject: string
  text?: string
  html?: string
  from?: string | { address: string, name?: string }
  replyTo?: string | { address: string, name?: string }
  /** The line inboxes show next to the subject, for the mail plugin's layout */
  preheader?: string
  /** Send it in the mail plugin's layout. Default true */
  layout?: boolean
}

/**
 * A notification, written as a class. `via()` says which channels it goes to, and a `to<Channel>()` method what it
 * says on each: `toGame()` for `game`, `toMail()` for `mail`, `toDiscord()` for a `discord` channel.
 *
 * ```ts
 * class LevelUp extends Notification {
 *   constructor(private level: number) { super() }
 *   via() { return ['game', 'mail'] }
 *   toGame() { return { level: this.level } }
 *   toMail() { return { subject: `Level ${this.level}!`, text: `You reached level ${this.level}.` } }
 * }
 *
 * await player.notify(new LevelUp(5))
 * ```
 */
export abstract class Notification implements NotificationLike {
  /** The name the player's game and the log know it by. Defaults to the class name */
  static notificationType?: string

  /**
   * Send it in the call instead of queueing what queues, like mail. Undefined leaves it to each channel and the mail
   * plugin's options
   */
  queued?: boolean

  abstract via(to: Notifiable): string[]
  toGame?(to: Notifiable): unknown
  toMail?(to: Notifiable): NotificationMail
  /** What the `database` channel keeps, as JSON */
  toDatabase?(to: Notifiable): unknown
}

/** Who a delivery is for, as plain JSON */
export interface Recipient {
  type: string
  id: string
}

/** One notification on one channel for one recipient, what a channel's `send()` gets */
export interface Delivery<TPayload = unknown> {
  /** The same for every channel and recipient of one notify() */
  id: string
  channel: string
  /** The notification's type, see `Notification.notificationType` */
  type: string
  recipient: Recipient
  /** Where it goes, from the recipient's `routeNotificationFor()` or the channel's `route()` */
  route: string | string[]
  /** What the notification's `to<Channel>()` returned */
  payload: TPayload
  /** The notification's `queued`, for channels that hand on to something that queues itself */
  queued?: boolean
  sentAt: string
}

/**
 * Delivers notifications of one kind: in the game, by mail, to Discord. Add your own with `channel()`.
 */
export interface NotificationChannel<TPayload = unknown> {
  /**
   * Where it goes for `to` when the recipient's `routeNotificationFor()` doesn't say. Undefined skips the channel for
   * that recipient, e.g. an account without an email address. Without `route()`, a channel needs the recipient's
   */
  route?(to: Notifiable, recipient: Recipient): string | string[] | undefined | Promise<string | string[] | undefined>
  send(delivery: Delivery<TPayload>): void | Promise<void>
  /**
   * Run `send()` on the server's queue, tried again when it throws, rather than in the notify() call. For channels
   * that call a slow or flaky service. A notification with `queued = false` is sent in the call still
   */
  queued?: boolean
}

export interface NotificationsApi {
  /** The same as `notify()` from the engine: send `notification` to one recipient or several */
  send(to: Notifiable | Notifiable[], notification: Notification): Promise<void>
  /** Add a channel, or replace one: `channel('discord', { queued: true, route, send })` */
  channel(name: string, channel: NotificationChannel<any>): void
  /** What the `database` channel kept for `to`, the latest first. Empty without a database */
  stored(to: Notifiable, options?: { unread?: boolean, limit?: number, offset?: number }): Promise<StoredNotification[]>
  unreadCount(to: Notifiable): Promise<number>
  /** Mark `to`'s notifications read, those with these ids or notification ids, all of them without. Returns how many */
  markRead(to: Notifiable, ids?: string[]): Promise<number>
  /** Delete `to`'s notifications, those with these ids or notification ids, all of them without. Returns how many */
  forget(to: Notifiable, ids?: string[]): Promise<number>
}

declare module '@mavonengine/core/Plugins/types' {
  interface ServerPluginApis {
    '@mavonengine/notifications': NotificationsApi
  }
}

export interface NotificationsOptions {
  /** Only mail accounts whose email address was confirmed, with the link the auth plugin mails. Default false */
  verifiedEmailOnly: boolean
  /** How often a queued channel's delivery is tried. Default 3 */
  tries: number
  /** Default 10s, then 1 minute */
  backoffMs: number | number[]
  /** Delete stored notifications this many days after they were read. 0 keeps them. Default 90 */
  keepReadDays: number
}

export function parseOptions(raw: Record<string, unknown> = {}): NotificationsOptions {
  return {
    verifiedEmailOnly: raw.verifiedEmailOnly === true,
    tries: typeof raw.tries === 'number' && raw.tries >= 1
      ? Math.floor(raw.tries)
      : 3,
    backoffMs: typeof raw.backoffMs === 'number' || (Array.isArray(raw.backoffMs) && raw.backoffMs.every(ms => typeof ms === 'number'))
      ? raw.backoffMs as number | number[]
      : [10_000, 60_000],
    keepReadDays: typeof raw.keepReadDays === 'number' && raw.keepReadDays >= 0
      ? raw.keepReadDays
      : 90,
  }
}

/** What the channels use of the mail plugin, by shape, so this plugin doesn't need it installed */
interface MailLike {
  send(mail: NotificationMail & { to: string | string[] }, options?: { queued?: boolean }): Promise<unknown>
}

/** What the mail channel uses of the auth plugin */
interface AuthLike {
  account(id: string): Promise<{ email: string | null, emailVerifiedAt: string | null } | undefined>
}

interface Channel {
  emit(event: string, data: unknown, options?: { reliable?: boolean }): void
  on(event: string, callback: (data: unknown) => void): void
}

interface NotificationsState {
  ctx: ServerPluginContext
  options: NotificationsOptions
  channels: Map<string, NotificationChannel<any>>
  /** Open game connections per account */
  connections: Map<string, Set<Channel>>
  warned: Set<string>
  /** The `database` channel's notifications, once `setup()` found a database */
  store?: NotificationStore
  pruner?: ReturnType<typeof setInterval>
  api: NotificationsApi
}

const STATES = Symbol.for('mavonengine.notifications.states')

function registry(): WeakMap<object, NotificationsState> {
  return ((globalThis as Record<symbol, unknown>)[STATES] ??= new WeakMap()) as WeakMap<object, NotificationsState>
}

/** The notifications of a server that runs this plugin, for the game's code. Undefined without it */
export function notifications(server: object): NotificationsApi | undefined {
  return registry().get(server)?.api
}

/** The name of a notification's class, or what it set as its type */
export function notificationType(notification: NotificationLike): string {
  const ctor = notification.constructor as { notificationType?: string, name?: string }
  return ctor.notificationType ?? (ctor.name && ctor.name !== 'Object'
    ? ctor.name
    : 'notification')
}

function warnOnce(state: NotificationsState, key: string, message: string) {
  if (state.warned.has(key))
    return
  state.warned.add(key)
  state.ctx.logger?.warn(`Notifications: ${message}`)
}

/** The `game` channel: to the open game connections of the recipient's account, or the accounts it routes to */
function gameChannel(state: NotificationsState): NotificationChannel {
  return {
    route: (_to, recipient) => recipient.type === 'account'
      ? recipient.id
      : undefined,
    send(delivery) {
      const message: GameNotification = {
        id: delivery.id,
        type: delivery.type,
        data: delivery.payload,
        sentAt: delivery.sentAt,
      }
      for (const accountId of [delivery.route].flat()) {
        for (const channel of state.connections.get(accountId) ?? [])
          channel.emit(NOTIFICATION_MESSAGE, message, { reliable: true })
      }
    },
  }
}

/** The `mail` channel: through the mail plugin, to the account's email from the auth plugin */
function mailChannel(state: NotificationsState): NotificationChannel<NotificationMail> {
  return {
    async route(_to, recipient) {
      if (recipient.type !== 'account')
        return undefined
      const auth = state.ctx.plugin<AuthLike>('@mavonengine/auth')
      if (!auth) {
        warnOnce(state, 'no-auth', 'mail goes to accounts\' email addresses, which needs the auth plugin (@mavonengine/auth). Without it, only recipients whose routeNotificationFor(\'mail\') gives an address are mailed')
        return undefined
      }
      const account = await auth.account(recipient.id)
      if (!account?.email || (state.options.verifiedEmailOnly && !account.emailVerifiedAt))
        return undefined
      return account.email
    },
    async send(delivery) {
      const mail = state.ctx.plugin<MailLike>('@mavonengine/mail')
      if (!mail) {
        warnOnce(state, 'no-mail', 'a notification goes to the mail channel, but the project has no mail plugin (@mavonengine/mail), so no mail is sent')
        return
      }
      // The mail plugin queues and retries the mail itself
      await mail.send({ ...delivery.payload, to: delivery.route }, delivery.queued === false
        ? { queued: false }
        : undefined)
    },
  }
}

/** Tell every open game of the account its unread count */
async function pushUnread(state: NotificationsState, accountId: string) {
  const open = state.connections.get(accountId)
  if (!open?.size || !state.store)
    return
  const unread = await state.store.unreadCount({ type: 'account', id: accountId })
  for (const channel of open)
    channel.emit(UNREAD_MESSAGE, { unread }, { reliable: true })
}

/** The `database` channel: kept in the plugin's table, for the recipient to read later */
function databaseChannel(state: NotificationsState): NotificationChannel {
  return {
    route: (_to, recipient) => recipient.id,
    async send(delivery) {
      if (!state.store) {
        warnOnce(state, 'no-database', 'a notification goes to the database channel, but the project has no database plugin such as @mavonengine/sqlite, so it isn\'t kept')
        return
      }
      await state.store.add(delivery.recipient, {
        notificationId: delivery.id,
        type: delivery.type,
        data: delivery.payload,
        createdAt: delivery.sentAt,
      })
      if (delivery.recipient.type === 'account')
        await pushUnread(state, delivery.recipient.id)
    },
  }
}

function ownerOf(to: Notifiable): Owner {
  const id = to.notifiableId()
  if (id === undefined)
    throw new Error(`This ${to.notifiableType} has no id, so it has no notifications`)
  return { type: to.notifiableType, id }
}

function sendJob(state: NotificationsState) {
  return class SendNotification extends Job<Delivery> {
    static jobName = 'notifications:send'
    tries = state.options.tries
    backoffMs = state.options.backoffMs

    async handle() {
      const channel = state.channels.get(this.data.channel)
      if (!channel)
        throw new Error(`No notification channel ${JSON.stringify(this.data.channel)}`)
      await channel.send(this.data)
    }
  }
}

function capitalized(name: string) {
  return name.charAt(0).toUpperCase() + name.slice(1)
}

function createState(ctx: ServerPluginContext): NotificationsState {
  const state = {
    ctx,
    options: parseOptions(ctx.options),
    channels: new Map(),
    connections: new Map(),
    warned: new Set(),
  } as unknown as NotificationsState
  state.channels.set('game', gameChannel(state))
  state.channels.set('mail', mailChannel(state))
  state.channels.set('database', databaseChannel(state))
  const SendNotification = sendJob(state)
  ctx.queue.register(SendNotification)

  /**
   * Work out every delivery before sending any, so a notification that is wrong (a channel without its
   * to<Channel>(), one that doesn't exist) throws without having reached anyone
   */
  const send = async (to: Notifiable[], notification: NotificationLike) => {
    const type = notificationType(notification)
    const id = crypto.randomUUID()
    const sentAt = new Date().toISOString()
    const queued = (notification as Notification).queued
    const deliveries: { channel: NotificationChannel, delivery: Delivery }[] = []

    for (const notifiable of to) {
      const recipientId = notifiable.notifiableId()
      if (recipientId === undefined) {
        ctx.logger?.debug?.(`Notifications: ${type} skips a ${notifiable.notifiableType} without an id, e.g. a player without an account`)
        continue
      }
      const recipient: Recipient = { type: notifiable.notifiableType, id: recipientId }

      for (const name of new Set(notification.via(notifiable))) {
        const channel = state.channels.get(name)
        if (!channel) {
          throw new Error(`${type} goes to the ${name} channel, which doesn't exist. Channels: ${[
            ...state.channels.keys(),
          ].join(', ')}`)
        }

        const method = `to${capitalized(name)}`
        const render = (notification as unknown as Record<string, unknown>)[method]
        if (typeof render !== 'function')
          throw new TypeError(`${type} goes to the ${name} channel, but has no ${method}()`)

        const route = notifiable.routeNotificationFor?.(name) ?? await channel.route?.(notifiable, recipient)
        if (route === undefined || (Array.isArray(route) && route.length === 0))
          continue

        const payload = render.call(notification, notifiable)
        deliveries.push({
          channel,
          delivery: {
            id,
            channel: name,
            type,
            recipient,
            route,
            payload,
            ...(queued !== undefined
              ? { queued }
              : {}),
            sentAt,
          },
        })
      }
    }

    // Kept first, so a game that marks the toast read finds it stored
    deliveries.sort((a, b) => Number(b.delivery.channel === 'database') - Number(a.delivery.channel === 'database'))
    for (const { channel, delivery } of deliveries) {
      if (channel.queued && queued !== false)
        await ctx.queue.dispatch(new SendNotification(delivery))
      else
        await channel.send(delivery)
    }
  }

  const changed = async (owner: Owner, count: number) => {
    if (count > 0 && owner.type === 'account')
      await pushUnread(state, owner.id)
    return count
  }

  state.api = {
    send: (to, notification) => send(Array.isArray(to)
      ? to
      : [to], notification),
    channel: (name, channel) => void state.channels.set(name, channel),
    stored: async (to, options) => state.store
      ? state.store.list(ownerOf(to), options)
      : [],
    unreadCount: async to => state.store
      ? state.store.unreadCount(ownerOf(to))
      : 0,
    markRead: async (to, ids) => {
      const owner = ownerOf(to)
      return state.store
        ? changed(owner, await state.store.markRead(owner, ids))
        : 0
    },
    forget: async (to, ids) => {
      const owner = ownerOf(to)
      return state.store
        ? changed(owner, await state.store.forget(owner, ids))
        : 0
    },
  }
  return state
}

const DAY_MS = 24 * 60 * 60 * 1000

function isRequestId(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_REQUEST_ID
}

/** A list or read request from a player's game. It is player input, so only what is asked for well is answered */
function answer(state: NotificationsState, channel: Channel, accountId: string, kind: 'list' | 'read', raw: unknown) {
  const request = raw as Partial<ListRequest & ReadRequest> | null
  if (!request || typeof request !== 'object' || !isRequestId(request.requestId))
    return
  const requestId = request.requestId
  const owner: Owner = { type: 'account', id: accountId }
  const reply = (result: Omit<NotificationsResult, 'requestId'>) => channel.emit(RESULT_MESSAGE, { requestId, ...result } satisfies NotificationsResult, { reliable: true })

  const store = state.store
  if (!store) {
    reply({ unread: 0, error: 'Notifications aren\'t kept: the server has no database' })
    return
  }

  const run = async () => {
    if (kind === 'list') {
      const limit = typeof request.limit === 'number'
        ? Math.min(MAX_PAGE, request.limit)
        : undefined
      const offset = typeof request.offset === 'number'
        ? request.offset
        : undefined
      const notifications = await store.list(owner, { unread: request.unread === true, limit, offset })
      reply({ notifications, unread: await store.unreadCount(owner) })
      return
    }

    let ids: string[] | undefined
    if (request.ids !== undefined) {
      if (!Array.isArray(request.ids) || request.ids.length > MAX_READ_IDS || !request.ids.every(isRequestId)) {
        reply({ unread: await store.unreadCount(owner), error: `ids must be up to ${MAX_READ_IDS} notification ids` })
        return
      }
      ids = request.ids
    }
    const marked = await store.markRead(owner, ids)
    reply({ marked, unread: await store.unreadCount(owner) })
    // The account's other games show the new count too
    if (marked > 0)
      await pushUnread(state, accountId)
  }

  run().catch((err) => {
    state.ctx.logger?.error(`Notifications: could not answer a ${kind} request: ${(err as Error)?.message ?? err}`)
    reply({ unread: 0, error: 'Could not read the notifications' })
  })
}

const plugin = {
  name: 'Notifications',
  migrations,
  api(ctx: ServerPluginContext): NotificationsApi {
    const state = createState(ctx)
    registry().set(ctx.server, state)
    return state.api
  },
  notify(to: Notifiable[], notification: NotificationLike, ctx: ServerPluginContext) {
    const state = registry().get(ctx.server)
    if (!state)
      throw new Error('The notifications plugin isn\'t running')
    return state.api.send(to, notification as Notification)
  },
  setup(ctx: ServerPluginContext) {
    const state = registry().get(ctx.server)
    if (!state || !ctx.db)
      return
    const store = new NotificationStore(ctx.db, ctx.table('notifications'))
    state.store = store

    const keepDays = state.options.keepReadDays
    if (keepDays > 0) {
      const prune = () => store.prune(new Date(Date.now() - keepDays * DAY_MS).toISOString()).catch((err) => {
        ctx.logger?.error(`Notifications: could not delete old read notifications: ${(err as Error)?.message ?? err}`)
      })
      void prune()
      state.pruner = setInterval(prune, DAY_MS)
      state.pruner.unref?.()
    }
  },
  onConnection(channel: ServerChannel, _client: unknown, ctx: ServerPluginContext) {
    const identity = ctx.identity(channel)
    const state = registry().get(ctx.server)
    if (!identity || !state)
      return
    let open = state.connections.get(identity.id)
    if (!open)
      state.connections.set(identity.id, open = new Set())
    open.add(channel)

    channel.on(LIST_MESSAGE, data => answer(state, channel, identity.id, 'list', data))
    channel.on(READ_MESSAGE, data => answer(state, channel, identity.id, 'read', data))
    // So the game can show a badge right away
    pushUnread(state, identity.id).catch(() => {})
  },
  onDisconnect(channel: ServerChannel, ctx: ServerPluginContext) {
    const identity = ctx.identity(channel)
    const open = identity && registry().get(ctx.server)?.connections.get(identity.id)
    if (!open)
      return
    open.delete(channel)
    if (open.size === 0)
      registry().get(ctx.server)!.connections.delete(identity!.id)
  },
  destroy(ctx: ServerPluginContext) {
    const state = registry().get(ctx.server)
    clearInterval(state?.pruner)
    registry().delete(ctx.server)
  },
} satisfies ServerPlugin

export default plugin
