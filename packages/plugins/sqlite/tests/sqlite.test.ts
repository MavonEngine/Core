import type { ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { Kysely } from 'kysely'
import { existsSync, mkdtempSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { runPluginMigrations } from '@mavonengine/core/Plugins/Database/migrate'
import { sql } from 'kysely'
import { afterEach, describe, expect, it, vi } from 'vitest'
import plugin, { databasePath, DEFAULT_PATH, openSqlite, PATH_ENV } from '../src/index'

function tempDir() {
  return realpathSync.native(mkdtempSync(join(tmpdir(), 'mavonengine-sqlite-')))
}

function context(options: Record<string, unknown> = {}, projectRoot = tempDir()) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  return {
    ctx: {
      package: '@mavonengine/sqlite',
      options,
      projectRoot,
      logger,
    } as unknown as ServerPluginContext,
    logger,
    projectRoot,
  }
}

const open: Kysely<any>[] = []
function track(db: Kysely<any>) {
  open.push(db)
  return db
}

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(open.splice(0).map(db => db.destroy()))
})

describe('openSqlite', () => {
  it('runs Kysely queries on node:sqlite', async () => {
    const db = track(openSqlite(':memory:'))
    await db.schema.createTable('players')
      .addColumn('id', 'integer', c => c.primaryKey().autoIncrement())
      .addColumn('name', 'text', c => c.notNull())
      .addColumn('banned', 'integer', c => c.notNull().defaultTo(0))
      .addColumn('seen', 'text')
      .addColumn('score', 'integer', c => c.notNull().defaultTo(0))
      .execute()

    const inserted = await db.insertInto('players')
      .values({
        name: 'ada',
        banned: true,
        seen: new Date('2026-01-02T03:04:05Z'),
        score: 10,
      })
      .returning(['id', 'name'])
      .executeTakeFirst()
    expect(inserted).toEqual({ id: 1, name: 'ada' })

    const result = await db.insertInto('players').values({
      name: 'bob',
      banned: false,
      seen: undefined,
      score: 30,
    }).executeTakeFirst()
    expect(result.insertId).toBe(2n)

    expect(await db.selectFrom('players').select(['name', 'banned', 'seen']).orderBy('score', 'desc').execute()).toEqual([
      { name: 'bob', banned: 0, seen: null },
      { name: 'ada', banned: 1, seen: '2026-01-02T03:04:05.000Z' },
    ])

    const updated = await db.updateTable('players').set({ score: sql`score + 5` }).where('name', '=', 'ada').executeTakeFirst()
    expect(updated.numUpdatedRows).toBe(1n)
    expect(await db.selectFrom('players').select(eb => eb.fn.sum('score').as('total')).executeTakeFirst()).toEqual({ total: 45 })
    expect((await sql<{ n: number }>`select count(*) as n from players`.execute(db)).rows).toEqual([
      { n: 2 },
    ])
  })

  it('rolls back a transaction that fails', async () => {
    const db = track(openSqlite(':memory:'))
    await db.schema.createTable('t').addColumn('n', 'integer').execute()

    await expect(db.transaction().execute(async (trx) => {
      await trx.insertInto('t').values({ n: 1 }).execute()
      throw new Error('stop')
    })).rejects.toThrow('stop')

    expect(await db.selectFrom('t').selectAll().execute()).toEqual([])
  })

  it('creates the file and its directory, in WAL mode, and keeps the data', async () => {
    const path = join(tempDir(), 'nested', 'game.sqlite')
    const db = openSqlite(path)
    await db.schema.createTable('t').addColumn('n', 'integer').execute()
    await db.insertInto('t').values({ n: 7 }).execute()
    await db.destroy()

    const raw = new DatabaseSync(path)
    expect(raw.prepare('PRAGMA journal_mode').get()).toEqual({ journal_mode: 'wal' })
    expect(raw.prepare('select n from t').all()).toEqual([
      { n: 7 },
    ])
    raw.close()
  })

  it('enforces foreign keys', async () => {
    const db = track(openSqlite(':memory:'))
    await db.schema.createTable('a').addColumn('id', 'integer', c => c.primaryKey()).execute()
    await db.schema.createTable('b').addColumn('a_id', 'integer', c => c.references('a.id')).execute()

    await expect(db.insertInto('b').values({ a_id: 1 }).execute()).rejects.toThrow(/FOREIGN KEY/)
  })
})

describe('databasePath', () => {
  it('is relative to the project root, with the environment first', () => {
    // Absolute on every platform: on Windows resolve() adds the current drive
    const root = resolve('/game')
    const elsewhere = resolve('/var/lib/x.sqlite')
    const live = resolve('/data/live.sqlite')

    expect(databasePath({}, root, {})).toBe(resolve(root, DEFAULT_PATH))
    expect(databasePath({ path: 'db/x.sqlite' }, root, {})).toBe(resolve(root, 'db', 'x.sqlite'))
    expect(databasePath({ path: elsewhere }, root, {})).toBe(elsewhere)
    expect(databasePath({ path: 'db/x.sqlite' }, root, { [PATH_ENV]: live })).toBe(live)
    expect(databasePath({ path: ':memory:' }, root, {})).toBe(':memory:')
  })
})

describe('the plugin', () => {
  it('opens the database in .mavonengine/data/ of the project', async () => {
    const { ctx, logger, projectRoot } = context()

    const db = track(plugin.database!(ctx)!)
    await sql`select 1`.execute(db)

    expect(existsSync(join(projectRoot, DEFAULT_PATH))).toBe(true)
    expect(logger.info).toHaveBeenCalledWith(`SQLite: ${join(projectRoot, DEFAULT_PATH)}`)
  })

  it('can keep the database in memory', () => {
    const { ctx, logger, projectRoot } = context({ path: ':memory:' })

    track(plugin.database!(ctx)!)

    expect(existsSync(join(projectRoot, '.mavonengine'))).toBe(false)
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('in memory'))
  })

  it('keeps plugin tables and their migrations across restarts', async () => {
    const root = tempDir()
    const migrations = {
      '001_init': {
        up: async (db: Kysely<any>, { table }: { table(name: string): string }) => {
          await db.schema.createTable(table('mutes')).addColumn('player', 'text', c => c.primaryKey()).execute()
        },
      },
    }

    const first = plugin.database!(context({}, root).ctx)!
    expect(await runPluginMigrations(first, '@mavonengine/chat', migrations)).toEqual(['001_init'])
    await first.insertInto('chat_mutes').values({ player: 'p1' }).execute()
    await first.destroy()

    const second = track(plugin.database!(context({}, root).ctx)!)
    expect(await runPluginMigrations(second, '@mavonengine/chat', migrations)).toEqual([])
    expect(await second.selectFrom('chat_mutes').selectAll().execute()).toEqual([
      { player: 'p1' },
    ])
  })
})
