import type { Kysely } from 'kysely'
import type { Server as NodeServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DatabaseSource } from '../../../../src/Networking/Server/Stats/DatabaseInspector'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HttpServer from '../../../../src/Networking/Server/Http/HttpServer'
import DatabaseInspector, { jsonValue, MAX_PAGE_SIZE, MAX_VALUE_CHARS } from '../../../../src/Networking/Server/Stats/DatabaseInspector'
import { runPluginMigrations } from '../../../../src/Plugins/Database/migrate'
import { memoryDb } from '../../../Plugins/Database/memoryDb'

let db: Kysely<any>

function source(overrides: Partial<DatabaseSource> = {}): DatabaseSource {
  return {
    db,
    databaseProvider: '@mavonengine/sqlite',
    databasePlugins: () => [
      '@mavonengine/chat',
      'acme',
      '@acme/chat',
      '@mavonengine/sqlite',
    ],
    ...overrides,
  }
}

async function seed() {
  await runPluginMigrations(db, '@mavonengine/chat', {
    '001_init': {
      up: async (db, { table }) => void await db.schema.createTable(table('mutes')).addColumn('player', 'text', c => c.primaryKey()).addColumn('until', 'integer').execute(),
    },
    '002_reason': {
      up: async (db, { table }) => void await db.schema.alterTable(table('mutes')).addColumn('reason', 'text').execute(),
    },
  })
  await db.schema.createTable('acme_chat_rooms').addColumn('id', 'integer', c => c.primaryKey().autoIncrement()).execute()
  await db.schema.createTable('acme_scores').addColumn('n', 'integer', c => c.notNull().defaultTo(0)).execute()
  await db.schema.createTable('game_scores').addColumn('player', 'text').addColumn('score', 'integer').execute()
  await db.schema.createTable('old__migrations').addColumn('x', 'text').execute()

  for (let i = 0; i < 120; i++)
    await db.insertInto('game_scores').values({ player: `p${i}`, score: i }).execute()
  await db.insertInto('chat_mutes').values({ player: 'p1', until: null, reason: 'spam' }).execute()
}

beforeEach(async () => {
  db = memoryDb()
  await seed()
})

afterEach(async () => {
  await db.destroy()
})

describe('databaseInspector', () => {
  it('lists the tables with whose they are, their columns and rows, and the migrations apart', async () => {
    const overview = await new DatabaseInspector(source()).overview()

    expect(overview.provider).toBe('@mavonengine/sqlite')
    expect(overview.tables.map(({ name, plugin, rows }) => ({ name, plugin, rows }))).toEqual([
      // The longest prefix wins: acme_chat_ is @acme/chat's, not acme's
      { name: 'acme_chat_rooms', plugin: '@acme/chat', rows: 0 },
      { name: 'acme_scores', plugin: 'acme', rows: 0 },
      { name: 'chat_mutes', plugin: '@mavonengine/chat', rows: 1 },
      { name: 'game_scores', plugin: null, rows: 120 },
    ])
    expect(overview.tables[2].columns).toEqual([
      {
        name: 'player',
        type: 'TEXT',
        nullable: true,
        autoIncrement: false,
        hasDefault: false,
      },
      {
        name: 'until',
        type: 'INTEGER',
        nullable: true,
        autoIncrement: false,
        hasDefault: false,
      },
      {
        name: 'reason',
        type: 'TEXT',
        nullable: true,
        autoIncrement: false,
        hasDefault: false,
      },
    ])

    expect(overview.migrations).toEqual([
      {
        plugin: '@mavonengine/chat',
        table: 'chat__migrations',
        applied: [
          {
            name: '001_init',
            executedAt: expect.any(String),
          },
          {
            name: '002_reason',
            executedAt: expect.any(String),
          },
        ],
      },
      // Not the engine's: listed, without what it can't read
      { plugin: null, table: 'old__migrations', applied: [] },
    ])
  })

  it('is empty without a database', async () => {
    expect(await new DatabaseInspector(source({ db: undefined, databaseProvider: undefined })).overview()).toEqual({ provider: null, tables: [], migrations: [] })
    expect(await new DatabaseInspector(source({ db: undefined })).page('game_scores')).toBeUndefined()
  })

  it('pages through a table, within limits', async () => {
    const inspector = new DatabaseInspector(source())

    const first = await inspector.page('game_scores')
    expect(first).toMatchObject({
      table: 'game_scores',
      total: 120,
      offset: 0,
      limit: 50,
    })
    expect(first!.rows).toHaveLength(50)
    expect(first!.rows[0]).toEqual({ player: 'p0', score: 0 })

    const last = await inspector.page('game_scores', 100, 50)
    expect(last!.rows.map(row => row.player)).toEqual(Array.from({ length: 20 }, (_, i) => `p${100 + i}`))

    expect((await inspector.page('game_scores', -5, 100_000))!).toMatchObject({ offset: 0, limit: MAX_PAGE_SIZE })
    expect((await inspector.page('game_scores', Number.NaN, Number.NaN))!).toMatchObject({ offset: 0, limit: 50 })
  })

  it('only reads tables the database has', async () => {
    const inspector = new DatabaseInspector(source())

    expect(await inspector.page('nope')).toBeUndefined()
    expect(await inspector.page('game_scores; drop table game_scores')).toBeUndefined()
    expect((await inspector.page('game_scores'))!.total).toBe(120)
  })

  it('turns values into what JSON can carry', () => {
    expect(jsonValue(5n)).toBe(5)
    expect(jsonValue(2n ** 70n)).toBe('1180591620717411303424')
    expect(jsonValue(new Date('2026-01-02T03:04:05Z'))).toBe('2026-01-02T03:04:05.000Z')
    expect(jsonValue(new Uint8Array(12))).toBe('<12 bytes>')
    expect(jsonValue('x'.repeat(MAX_VALUE_CHARS + 10))).toHaveLength(MAX_VALUE_CHARS + 1)
    expect(jsonValue(null)).toBeNull()
    expect(jsonValue({ a: 1 })).toEqual({ a: 1 })
  })
})

describe('database endpoints', () => {
  let listener: NodeServer | undefined

  afterEach(() => {
    listener?.close()
    listener = undefined
  })

  async function serve(adminToken?: string, inspector = new DatabaseInspector(source())) {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    } as any
    const http = new HttpServer(logger, {} as any, { adminToken, database: inspector })
    listener = await new Promise<NodeServer>((resolve) => {
      const server = http.app.listen(0, '127.0.0.1', () => resolve(server))
    })
    const { port } = listener.address() as AddressInfo
    return {
      http,
      logger,
      request: (path: string, token?: string) => fetch(`http://127.0.0.1:${port}${path}`, {
        headers: token
          ? { Authorization: `Bearer ${token}` }
          : {},
      }),
    }
  }

  it('serves the overview and pages of rows', async () => {
    const { request } = await serve()

    const overview = await (await request('/api/game/database')).json()
    expect(overview.tables.map((t: any) => t.name)).toContain('chat_mutes')

    const page = await (await request('/api/game/database/tables/game_scores?offset=110&limit=5')).json()
    expect(page).toMatchObject({
      table: 'game_scores',
      total: 120,
      offset: 110,
      limit: 5,
    })
    expect(page.rows.map((row: any) => row.player)).toEqual(['p110', 'p111', 'p112', 'p113', 'p114'])

    const missing = await request('/api/game/database/tables/nope')
    expect(missing.status).toBe(404)
    expect(await missing.json()).toEqual({ error: 'No table nope' })
  })

  it('asks for the admin token when the server has one', async () => {
    const { request } = await serve('secret')

    expect((await request('/api/game/database')).status).toBe(401)
    expect((await request('/api/game/database', 'wrong')).status).toBe(401)
    expect((await request('/api/game/database/tables/game_scores')).status).toBe(401)
    expect((await request('/api/game/database', 'secret')).status).toBe(200)
  })

  it('says what went wrong when the database can\'t be read', async () => {
    const broken = new DatabaseInspector(source())
    vi.spyOn(broken, 'overview').mockRejectedValue(new Error('disk I/O error'))
    const { request, logger } = await serve(undefined, broken)

    const res = await request('/api/game/database')

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'Could not read the database: disk I/O error' })
    expect(logger.error).toHaveBeenCalled()
  })

  it('lists the endpoints with the admin guard', async () => {
    const { http } = await serve('secret')

    const routes = http.routes.list().filter(route => route.path.startsWith('/api/game/database'))
    expect(routes.map(route => `${route.method} ${route.path}`)).toEqual(['GET /api/game/database', 'GET /api/game/database/tables/:name'])
    expect(routes[0].auth).toContain('admin token')
  })
})
