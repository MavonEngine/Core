/** The game socket message a notification reaches the player's game as */
export const NOTIFICATION_MESSAGE = 'notifications:notify'

/** The game event the client plugin triggers for each: `game.on(NOTIFICATION_EVENT, (n: GameNotification) => …)` */
export const NOTIFICATION_EVENT = 'notification'

/** A notification as the player's game gets it, from the `game` channel */
export interface GameNotification<T = unknown> {
  /** The same for every channel and recipient of one notify() */
  id: string
  /** The notification's `notificationType`, its class name unless it sets one */
  type: string
  /** What its `toGame()` returned */
  data: T
  /** ISO time it was sent */
  sentAt: string
}
