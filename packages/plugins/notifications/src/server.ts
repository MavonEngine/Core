import type { ServerChannel } from '@geckos.io/server'
import type { Notifiable, NotificationLike, ServerPlugin, ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { GameNotification } from './protocol'
import Job from '@mavonengine/core/Queue/Job'
import { NOTIFICATION_MESSAGE } from './protocol'

export type { GameNotification } from './protocol'
export { NOTIFICATION_EVENT, NOTIFICATION_MESSAGE } from './protocol'

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
}

declare module '@mavonengine/core/Plugins/types' {
  interface ServerPluginApis {
    '@mavonengine/notifications': NotificationsApi
  }
}

export interface NotificationsOptions {
  /** Only mail accounts whose email address was confirmed. Default false: the auth plugin can't confirm addresses yet */
  verifiedEmailOnly: boolean
  /** How often a queued channel's delivery is tried. Default 3 */
  tries: number
  /** Default 10s, then 1 minute */
  backoffMs: number | number[]
}

export function parseOptions(raw: Record<string, unknown> = {}): NotificationsOptions {
  return {
    verifiedEmailOnly: raw.verifiedEmailOnly === true,
    tries: typeof raw.tries === 'number' && raw.tries >= 1 ? Math.floor(raw.tries) : 3,
    backoffMs: typeof raw.backoffMs === 'number' || (Array.isArray(raw.backoffMs) && raw.backoffMs.every(ms => typeof ms === 'number'))
      ? raw.backoffMs as number | number[]
      : [10_000, 60_000],
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
}

interface NotificationsState {
  ctx: ServerPluginContext
  options: NotificationsOptions
  channels: Map<string, NotificationChannel<any>>
  /** Open game connections per account */
  connections: Map<string, Set<Channel>>
  warned: Set<string>
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
  return ctor.notificationType ?? (ctor.name && ctor.name !== 'Object' ? ctor.name : 'notification')
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
    route: (_to, recipient) => recipient.type === 'account' ? recipient.id : undefined,
    send(delivery) {
      const message: GameNotification = { id: delivery.id, type: delivery.type, data: delivery.payload, sentAt: delivery.sentAt }
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
      await mail.send({ ...delivery.payload, to: delivery.route }, delivery.queued === false ? { queued: false } : undefined)
    },
  }
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
  const state = { ctx, options: parseOptions(ctx.options), channels: new Map(), connections: new Map(), warned: new Set() } as unknown as NotificationsState
  state.channels.set('game', gameChannel(state))
  state.channels.set('mail', mailChannel(state))
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
        if (!channel)
          throw new Error(`${type} goes to the ${name} channel, which doesn't exist. Channels: ${[...state.channels.keys()].join(', ')}`)

        const method = `to${capitalized(name)}`
        const render = (notification as unknown as Record<string, unknown>)[method]
        if (typeof render !== 'function')
          throw new Error(`${type} goes to the ${name} channel, but has no ${method}()`)

        const route = notifiable.routeNotificationFor?.(name) ?? await channel.route?.(notifiable, recipient)
        if (route === undefined || (Array.isArray(route) && route.length === 0))
          continue

        const payload = render.call(notification, notifiable)
        deliveries.push({ channel, delivery: { id, channel: name, type, recipient, route, payload, ...(queued !== undefined ? { queued } : {}), sentAt } })
      }
    }

    for (const { channel, delivery } of deliveries) {
      if (channel.queued && queued !== false)
        await ctx.queue.dispatch(new SendNotification(delivery))
      else
        await channel.send(delivery)
    }
  }

  state.api = {
    send: (to, notification) => send(Array.isArray(to) ? to : [to], notification),
    channel: (name, channel) => void state.channels.set(name, channel),
  }
  return state
}

const plugin = {
  name: 'Notifications',
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
  onConnection(channel: ServerChannel, _client: unknown, ctx: ServerPluginContext) {
    const identity = ctx.identity(channel)
    const state = registry().get(ctx.server)
    if (!identity || !state)
      return
    let open = state.connections.get(identity.id)
    if (!open)
      state.connections.set(identity.id, open = new Set())
    open.add(channel)
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
    registry().delete(ctx.server)
  },
} satisfies ServerPlugin

export default plugin
