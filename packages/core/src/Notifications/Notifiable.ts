/**
 * Who a notification goes to: a player's account, a guild, a team. Implement it on your own classes, or extend
 * `notifiable(Base)` to get `notify()` as well. `Player` is one, as its account.
 */
export interface Notifiable {
  /** What kind of recipient this is, e.g. `account` or `guild`. With the id, it says who it is */
  readonly notifiableType: string
  /** Stable over restarts, e.g. the account or guild id. Undefined when it has none, e.g. a player without an account */
  notifiableId(): string | undefined
  /**
   * Where `channel` delivers to this recipient, e.g. its email address for `mail`. Undefined leaves it to the
   * notifications plugin, which finds an account's email through the auth plugin, or skips the channel
   */
  routeNotificationFor?(channel: string): string | string[] | undefined
}

/**
 * What the engine knows of a notification: which channels it goes to. Its class, with what it says on each channel
 * (`toMail()`, `toGame()`, …), comes from the notifications plugin, such as `@mavonengine/notifications`.
 */
export interface NotificationLike {
  via(to: Notifiable): string[]
}

/** Sends notifications: the game server, once it runs a notifications plugin */
export type Notifier = (to: Notifiable[], notification: NotificationLike) => Promise<void>

let notifier: Notifier | undefined
let warned = false

/**
 * Who sends this process's notifications: the server that started last, with its notifications plugin.
 * @internal
 */
export function setNotifier(next: Notifier | undefined): void {
  notifier = next
}

/** @internal */
export function currentNotifier(): Notifier | undefined {
  return notifier
}

/**
 * Send `notification` to one recipient or several, through the server's notifications plugin. Without one (or in the
 * browser), nothing is sent and that is logged once, like `ctx.db` is undefined without a database plugin.
 * Resolves once the notification is queued, or sent when it isn't queued.
 */
export function notify(to: Notifiable | Notifiable[], notification: NotificationLike): Promise<void> {
  const recipients = Array.isArray(to)
    ? to
    : [to]
  if (!notifier) {
    if (!warned) {
      warned = true
      console.warn('notify(): no notifications are sent, as no game server with a notifications plugin such as @mavonengine/notifications runs in this process')
    }
    return Promise.resolve()
  }
  return notifier(recipients, notification)
}

/** An account as a recipient, for one that isn't connected: `notify(account(id), new SeasonEnded())` */
export function account(id: string): Notifiable {
  return {
    notifiableType: 'account',
    notifiableId: () => id,
  }
}

type AbstractConstructor<T = object> = abstract new (...args: any[]) => T

/**
 * Give a class `notify()`. It still says who it is, as a `Notifiable`:
 *
 * ```ts
 * class Guild extends notifiable(BaseGuild) {
 *   readonly notifiableType = 'guild'
 *   notifiableId() { return this.id }
 *   routeNotificationFor(channel: string) { return channel === 'mail' ? this.officerEmails : undefined }
 * }
 *
 * await guild.notify(new WarDeclared(enemy))
 * ```
 *
 * With no class to extend, `notifiable()` alone.
 */
export function notifiable<TBase extends AbstractConstructor>(Base: TBase = Object as unknown as TBase) {
  abstract class NotifiableClass extends Base implements Notifiable {
    abstract readonly notifiableType: string
    abstract notifiableId(): string | undefined

    /** Send it a notification, see `notify()` */
    notify(notification: NotificationLike): Promise<void> {
      return notify(this, notification)
    }
  }
  return NotifiableClass
}

/** For tests: forget that `notify()` warned already */
export function resetNotifyWarning(): void {
  warned = false
}
