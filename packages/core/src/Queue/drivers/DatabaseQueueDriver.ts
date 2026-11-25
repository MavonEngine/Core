import type { Kysely } from 'kysely'
import type { PluginMigration } from '../../Plugins/Database/migrate'
import type { FailedJob, QueuedJob, QueueDriver, ReserveOptions } from './QueueDriver'
import { tableName } from '../../Plugins/Database/tables'

/**
 * The package the queue's tables and migrations are recorded under: `core_jobs`, `core_failed_jobs`, and
 * `core__migrations` for which of `queueMigrations` ran
 */
export const QUEUE_PACKAGE = '@mavonengine/core'

export const JOBS_TABLE = tableName(QUEUE_PACKAGE, 'jobs')
export const FAILED_JOBS_TABLE = tableName(QUEUE_PACKAGE, 'failed_jobs')

/**
 * Times are ms since the epoch in bigint columns rather than dates, which every database plugin stores and
 * compares the same way. Some drivers (pg) return bigints as strings, so they are read through `Number()`.
 */
export const queueMigrations: Record<string, PluginMigration> = {
  '001_create_jobs': {
    up: async (db, { table }) => {
      await db.schema
        .createTable(table('jobs'))
        .addColumn('id', 'varchar(36)', c => c.primaryKey())
        .addColumn('queue', 'varchar(255)', c => c.notNull())
        .addColumn('name', 'varchar(255)', c => c.notNull())
        .addColumn('payload', 'text', c => c.notNull())
        .addColumn('attempts', 'integer', c => c.notNull().defaultTo(0))
        .addColumn('reserved_at', 'bigint')
        .addColumn('available_at', 'bigint', c => c.notNull())
        .addColumn('created_at', 'bigint', c => c.notNull())
        .execute()

      await db.schema
        .createIndex(`${table('jobs')}_queue_available_at`)
        .on(table('jobs'))
        .columns(['queue', 'available_at'])
        .execute()

      await db.schema
        .createTable(table('failed_jobs'))
        .addColumn('id', 'varchar(36)', c => c.primaryKey())
        .addColumn('queue', 'varchar(255)', c => c.notNull())
        .addColumn('name', 'varchar(255)', c => c.notNull())
        .addColumn('payload', 'text', c => c.notNull())
        .addColumn('attempts', 'integer', c => c.notNull())
        .addColumn('error', 'text', c => c.notNull())
        .addColumn('failed_at', 'bigint', c => c.notNull())
        .execute()
    },
  },
}

/** How many due jobs `reserve()` looks at, for when other workers claim the first ones first */
const RESERVE_CANDIDATES = 5

interface JobRow {
  id: string
  queue: string
  name: string
  payload: string
  attempts: number | string
  reserved_at: number | string | null
  available_at: number | string
  created_at: number | string
}

/**
 * Keeps the jobs in the server's database, so they outlive a restart, and several servers on one database can
 * share them: a job is claimed with an update that only succeeds for one of them.
 */
export default class DatabaseQueueDriver implements QueueDriver {
  readonly name = 'database'

  constructor(private db: Kysely<any>) {}

  async push(job: QueuedJob): Promise<void> {
    await this.db.insertInto(JOBS_TABLE).values({
      id: job.id,
      queue: job.queue,
      name: job.name,
      payload: job.payload,
      attempts: job.attempts,
      reserved_at: null,
      available_at: job.availableAt,
      created_at: job.createdAt,
    }).execute()
  }

  async reserve({ names, queues, now, staleBefore }: ReserveOptions): Promise<QueuedJob | undefined> {
    if (names.length === 0 || queues?.length === 0)
      return undefined

    let query = this.db.selectFrom(JOBS_TABLE)
      .selectAll()
      .where('name', 'in', names)
      .where('available_at', '<=', now)
      .where(eb => eb.or([
        eb('reserved_at', 'is', null),
        eb('reserved_at', '<=', staleBefore),
      ]))
    if (queues)
      query = query.where('queue', 'in', queues)

    const candidates = await query.orderBy('available_at').orderBy('created_at').limit(RESERVE_CANDIDATES).execute() as JobRow[]

    for (const row of candidates) {
      // Only claims it when no other worker did since it was read: their reserved_at would differ
      const result = await this.db.updateTable(JOBS_TABLE)
        .set(eb => ({
          reserved_at: now,
          attempts: eb('attempts', '+', 1),
        }))
        .where('id', '=', row.id)
        .where(row.reserved_at === null
          ? eb => eb('reserved_at', 'is', null)
          : eb => eb('reserved_at', '=', row.reserved_at))
        .executeTakeFirst()

      if (Number(result.numUpdatedRows) === 1) {
        return {
          ...fromRow(row),
          attempts: Number(row.attempts) + 1,
        }
      }
    }

    return undefined
  }

  async delete(id: string): Promise<void> {
    await this.db.deleteFrom(JOBS_TABLE).where('id', '=', id).execute()
  }

  async release(id: string, availableAt: number): Promise<void> {
    await this.db.updateTable(JOBS_TABLE).set({ reserved_at: null, available_at: availableAt }).where('id', '=', id).execute()
  }

  async fail(job: QueuedJob, error: string, failedAt: number): Promise<void> {
    await this.db.transaction().execute(async (trx) => {
      await trx.deleteFrom(JOBS_TABLE).where('id', '=', job.id).execute()
      await trx.insertInto(FAILED_JOBS_TABLE).values({
        id: job.id,
        queue: job.queue,
        name: job.name,
        payload: job.payload,
        attempts: job.attempts,
        error,
        failed_at: failedAt,
      }).execute()
    })
  }

  async size(queue?: string): Promise<number> {
    let query = this.db.selectFrom(JOBS_TABLE).select(eb => eb.fn.countAll().as('count'))
    if (queue !== undefined)
      query = query.where('queue', '=', queue)
    const row = await query.executeTakeFirst()
    return Number(row?.count ?? 0)
  }

  async failed(limit: number): Promise<FailedJob[]> {
    const rows = await this.db.selectFrom(FAILED_JOBS_TABLE).selectAll().orderBy('failed_at', 'desc').limit(limit).execute()
    return rows.map(row => ({
      id: row.id,
      queue: row.queue,
      name: row.name,
      payload: row.payload,
      attempts: Number(row.attempts),
      error: row.error,
      failedAt: Number(row.failed_at),
    }))
  }

  async retry(id: string, now: number): Promise<boolean> {
    return this.db.transaction().execute(async (trx) => {
      const failed = await trx.selectFrom(FAILED_JOBS_TABLE).selectAll().where('id', '=', id).executeTakeFirst()
      if (!failed)
        return false

      await trx.deleteFrom(FAILED_JOBS_TABLE).where('id', '=', id).execute()
      await trx.insertInto(JOBS_TABLE).values({
        id,
        queue: failed.queue,
        name: failed.name,
        payload: failed.payload,
        attempts: 0,
        reserved_at: null,
        available_at: now,
        created_at: now,
      }).execute()
      return true
    })
  }

  async forget(id: string): Promise<boolean> {
    const result = await this.db.deleteFrom(FAILED_JOBS_TABLE).where('id', '=', id).executeTakeFirst()
    return Number(result.numDeletedRows) > 0
  }
}

function fromRow(row: JobRow): QueuedJob {
  return {
    id: row.id,
    queue: row.queue,
    name: row.name,
    payload: row.payload,
    attempts: Number(row.attempts),
    availableAt: Number(row.available_at),
    createdAt: Number(row.created_at),
  }
}
