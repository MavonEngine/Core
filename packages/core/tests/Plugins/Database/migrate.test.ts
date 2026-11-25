import type { Kysely } from 'kysely'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { hasMigrations, runPluginMigrations } from '../../../src/Plugins/Database/migrate'
import { migrationsTableName, tableName, tablePrefix } from '../../../src/Plugins/Database/tables'
import { memoryDb } from './memoryDb'

describe('table names', () => {
  it('prefixes tables with the package name', () => {
    expect(tablePrefix('@mavonengine/chat')).toBe('chat')
    expect(tablePrefix('@acme/chat')).toBe('acme_chat')
    expect(tablePrefix('my-plugin')).toBe('my_plugin')
    expect(tablePrefix('My.Plugin--2')).toBe('my_plugin_2')
    expect(tablePrefix('3d-trees')).toBe('p_3d_trees')
    expect(tableName('@mavonengine/chat', 'mutes')).toBe('chat_mutes')
    expect(migrationsTableName('@mavonengine/chat')).toBe('chat__migrations')
  })

  it('refuses names that give no valid or a clashing table', () => {
    expect(() => tablePrefix('@@--')).toThrow(/no table prefix/)
    expect(() => tableName('chat', 'mutes; drop table x')).toThrow(/letters, digits and underscores/)
    expect(() => tableName('chat', 'a-b')).toThrow()
    // Would be chat__migrations, the engine's own table
    expect(() => tableName('chat', '_migrations')).toThrow()
  })
})

describe('runPluginMigrations', () => {
  let db: Kysely<any>

  beforeEach(() => {
    db = memoryDb()
  })

  afterEach(async () => {
    await db.destroy()
  })

  const migrations = {
    '002_add_reason': {
      up: async (db: Kysely<any>, { table }: { table(name: string): string }) => {
        await db.schema.alterTable(table('mutes')).addColumn('reason', 'text').execute()
      },
    },
    '001_init': {
      up: async (db: Kysely<any>, { table }: { table(name: string): string }) => {
        await db.schema.createTable(table('mutes')).addColumn('player', 'text', c => c.primaryKey()).execute()
      },
    },
  }

  it('runs the migrations in the order of their names, each once', async () => {
    expect(await runPluginMigrations(db, '@mavonengine/chat', migrations)).toEqual(['001_init', '002_add_reason'])
    expect(await runPluginMigrations(db, '@mavonengine/chat', migrations)).toEqual([])

    await db.insertInto('chat_mutes').values({ player: 'p1', reason: 'spam' }).execute()
    expect(await db.selectFrom('chat_mutes').selectAll().execute()).toEqual([
      { player: 'p1', reason: 'spam' },
    ])

    const recorded = await db.selectFrom('chat__migrations').select('name').orderBy('name').execute()
    expect(recorded.map(row => row.name)).toEqual(['001_init', '002_add_reason'])
  })

  it('runs only the new ones on a database that has the earlier ones', async () => {
    await runPluginMigrations(db, 'chat', { '001_init': migrations['001_init'] })
    expect(await runPluginMigrations(db, 'chat', migrations)).toEqual(['002_add_reason'])
  })

  it('keeps the migrations of plugins apart', async () => {
    await runPluginMigrations(db, 'chat', migrations)
    expect(await runPluginMigrations(db, 'shop', migrations)).toEqual(['001_init', '002_add_reason'])
  })

  it('rolls a failing migration back and doesn\'t record it, keeping the ones before', async () => {
    const failing = {
      ...migrations,
      '003_broken': {
        up: async (db: Kysely<any>) => {
          await db.schema.createTable('chat_half').addColumn('id', 'integer').execute()
          throw new Error('boom')
        },
      },
    }

    await expect(runPluginMigrations(db, 'chat', failing)).rejects.toThrow('Migration 003_broken failed: boom')

    const tables = (await db.introspection.getTables()).map(t => t.name)
    expect(tables).toContain('chat_mutes')
    expect(tables).not.toContain('chat_half')

    // Tried again next time
    const fixed = {
      ...migrations,
      '003_broken': {
        up: async () => {},
      },
    }
    expect(await runPluginMigrations(db, 'chat', fixed)).toEqual(['003_broken'])
  })

  it('tells plugins with migrations apart', () => {
    expect(hasMigrations({})).toBe(false)
    expect(hasMigrations({ migrations: {} })).toBe(false)
    expect(hasMigrations({ migrations })).toBe(true)
  })
})
