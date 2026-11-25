import type { PluginMigration } from '@mavonengine/core/Plugins/types'
import type { Kysely } from 'kysely'
import type { StoredNotification } from './protocol'

/** Who a stored notification is for */
export interface Owner {
  type: string
  id: string
}

/** The most a page of stored notifications has */
export const MAX_PAGE = 100
/** The most JSON a stored notification's data may be, so one notification can't fill the database */
export const MAX_DATA_CHARS = 64 * 1024

export const migrations: Record<string, PluginMigration> = {
  '001_create_notifications': {
    async up(db, { table }) {
      await db.schema
        .createTable(table('notifications'))
        .addColumn('id', 'varchar(36)', c => c.primaryKey())
        // The same for every recipient and channel of one notify(), so the game's toast and the stored one match
        .addColumn('notification_id', 'varchar(36)', c => c.notNull())
        .addColumn('notifiable_type', 'varchar(64)', c => c.notNull())
        .addColumn('notifiable_id', 'varchar(255)', c => c.notNull())
        .addColumn('type', 'varchar(255)', c => c.notNull())
        .addColumn('data', 'text', c => c.notNull())
        .addColumn('read_at', 'varchar(32)')
        .addColumn('created_at', 'varchar(32)', c => c.notNull())
        .execute()

      await db.schema
        .createIndex(`${table('notifications')}_owner`)
        .on(table('notifications'))
        .columns(['notifiable_type', 'notifiable_id', 'created_at'])
        .execute()
    },
  },
}

interface Row {
  id: string
  notification_id: string
  notifiable_type: string
  notifiable_id: string
  type: string
  data: string
  read_at: string | null
  created_at: string
}

function fromRow(row: Row): StoredNotification {
  let data: unknown
  try {
    data = JSON.parse(row.data)
  }
  catch {
    data = null
  }
  return {
    id: row.id,
    notificationId: row.notification_id,
    type: row.type,
    data,
    readAt: row.read_at,
    createdAt: row.created_at,
  }
}

/** The notifications of the `database` channel, in the plugin's table */
export default class NotificationStore {
  constructor(private db: Kysely<any>, private table: string) {}

  async add(owner: Owner, notification: { notificationId: string, type: string, data: unknown, createdAt: string }): Promise<StoredNotification> {
    const json = JSON.stringify(notification.data ?? null)
    if (json === undefined)
      throw new TypeError(`The toDatabase() of ${notification.type} can't be stored as JSON`)
    if (json.length > MAX_DATA_CHARS)
      throw new RangeError(`The toDatabase() of ${notification.type} is ${json.length} characters of JSON, more than the ${MAX_DATA_CHARS} a notification may keep`)

    const row: Row = {
      id: crypto.randomUUID(),
      notification_id: notification.notificationId,
      notifiable_type: owner.type,
      notifiable_id: owner.id,
      type: notification.type,
      data: json,
      read_at: null,
      created_at: notification.createdAt,
    }
    await this.db.insertInto(this.table).values(row).execute()
    return fromRow(row)
  }

  /** The owner's notifications, the latest first */
  async list(owner: Owner, { unread = false, limit = 50, offset = 0 } = {}): Promise<StoredNotification[]> {
    let query = this.owned(this.db.selectFrom(this.table).selectAll(), owner)
    if (unread)
      query = query.where('read_at', 'is', null)
    const rows = await query
      .orderBy('created_at', 'desc')
      .orderBy('id', 'desc')
      .limit(Math.min(Math.max(1, Math.floor(limit) || 1), MAX_PAGE))
      .offset(Math.max(0, Math.floor(offset) || 0))
      .execute()
    return (rows as Row[]).map(fromRow)
  }

  async unreadCount(owner: Owner): Promise<number> {
    const row = await this.owned(this.db.selectFrom(this.table).select(eb => eb.fn.countAll().as('count')), owner)
      .where('read_at', 'is', null)
      .executeTakeFirst()
    return Number((row as { count?: unknown } | undefined)?.count ?? 0)
  }

  /**
   * Mark the owner's notifications read: those whose id or notification id is in `ids`, or all of them without.
   * Returns how many were unread
   */
  async markRead(owner: Owner, ids?: string[]): Promise<number> {
    if (ids && ids.length === 0)
      return 0
    let query = this.owned(this.db.updateTable(this.table).set({
      read_at: new Date().toISOString(),
    }), owner).where('read_at', 'is', null)
    if (ids) {
      query = query.where(eb => eb.or([
        eb('id', 'in', ids),
        eb('notification_id', 'in', ids),
      ]))
    }
    const result = await query.executeTakeFirst()
    return Number(result.numUpdatedRows)
  }

  /** Delete the owner's notifications whose id or notification id is in `ids`, or all of them without */
  async forget(owner: Owner, ids?: string[]): Promise<number> {
    if (ids && ids.length === 0)
      return 0
    let query = this.owned(this.db.deleteFrom(this.table), owner)
    if (ids) {
      query = query.where(eb => eb.or([
        eb('id', 'in', ids),
        eb('notification_id', 'in', ids),
      ]))
    }
    const result = await query.executeTakeFirst()
    return Number(result.numDeletedRows)
  }

  /** Delete what was read before `before`, an ISO time. Returns how many */
  async prune(before: string): Promise<number> {
    const result = await this.db.deleteFrom(this.table)
      .where('read_at', 'is not', null)
      .where('read_at', '<', before)
      .executeTakeFirst()
    return Number(result.numDeletedRows)
  }

  private owned<Q extends { where(...args: any[]): Q }>(query: Q, owner: Owner): Q {
    return query.where('notifiable_type', '=', owner.type).where('notifiable_id', '=', owner.id)
  }
}
