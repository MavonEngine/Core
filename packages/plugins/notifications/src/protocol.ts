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

/** A notification the `database` channel kept, as the server's api and the player's game get it */
export interface StoredNotification<T = unknown> {
  /** Its own id */
  id: string
  /** The id the game's toast of the same notify() had, see `GameNotification.id` */
  notificationId: string
  type: string
  /** What its `toDatabase()` returned */
  data: T
  /** ISO time it was read, null while unread */
  readAt: string | null
  createdAt: string
}

/** The game asks for its account's stored notifications: `{ requestId, unread?, limit?, offset? }` */
export const LIST_MESSAGE = 'notifications:list'
/** The game marks its account's notifications read: `{ requestId, ids? }`, all of them without ids */
export const READ_MESSAGE = 'notifications:read'
/** The server answers either: `NotificationsResult` */
export const RESULT_MESSAGE = 'notifications:result'
/** The server tells the game its account's unread count, on connecting and when it changes: `{ unread }` */
export const UNREAD_MESSAGE = 'notifications:unread'

export interface ListRequest {
  requestId: string
  unread?: boolean
  limit?: number
  offset?: number
}

export interface ReadRequest {
  requestId: string
  ids?: string[]
}

export interface NotificationsResult {
  requestId: string
  /** The page asked for, in answer to a list */
  notifications?: StoredNotification[]
  /** How many were marked read, in answer to a read */
  marked?: number
  unread: number
  /** Why it couldn't be done, e.g. no database */
  error?: string
}

/** Longest request id the server takes */
export const MAX_REQUEST_ID = 64
/** Most ids one read may name */
export const MAX_READ_IDS = 100
