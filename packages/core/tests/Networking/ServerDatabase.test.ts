import type { ServerChannel } from '@geckos.io/server'
import type { Kysely } from 'kysely'
import type { ServerPlugin, ServerPluginContext } from '../../src/Plugins/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import winston from 'winston'
import Player from '../../src/Networking/Entities/Player'
import Server from '../../src/Networking/Server/Server'
import { memoryDb } from '../Plugins/Database/memoryDb'
import { installPlugin, tempProject, writeConfig } from '../Plugins/fixtures'

vi.mock('@geckos.io/server', () => ({
  default: vi.fn(() => ({ onConnection: vi.fn(), connectionsManager: { connections: new Map() }, emit: vi.fn(), listen: vi.fn() })),
}))

class TestClient extends Player {
  update(_delta: number): void { }
  updateFromNetwork(_data: object): void { }
}

class TestServer extends Server<TestClient> {
  getStateSyncDistance(): number {
    return 0
  }

  protected onCommand(_command: any, _delta: number): void { }

  protected onConnection(channel: ServerChannel): TestClient {
    return new TestClient(channel.id)
  }
}

describe('server database', () => {
  let logger: winston.Logger

  beforeEach(() => {
    logger = winston.createLogger({ transports: [], silent: true })
  })

  function startable(server: TestServer) {
    vi.spyOn(server.http, 'start').mockImplementation(() => {})
    return server
  }

  function provider(db: Kysely<any>, extra: Partial<ServerPlugin> = {}): ServerPlugin {
    return { name: 'sqlite', database: () => db, ...extra }
  }

  const mutes: ServerPlugin['migrations'] = {
    '001_init': {
      up: async (db, { table }) => {
        await db.schema.createTable(table('mutes')).addColumn('player', 'text', c => c.primaryKey()).execute()
      },
    },
  }

  it('has no database without a database plugin, and runs plugins with migrations without one', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const contexts: ServerPluginContext[] = []
    const server = startable(new TestServer(logger, undefined, {
      plugins: [{ package: 'chat', options: {}, plugin: { migrations: mutes, setup: ctx => void contexts.push(ctx) } }],
    }))

    await server.start()

    expect(server.db).toBeUndefined()
    expect(contexts[0].db).toBeUndefined()
    expect(contexts[0].table('mutes')).toBe('chat_mutes')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('chat has database migrations, but the project has no database plugin'))
    await server.stop()
  })

  it('starts synchronously when no plugin has migrations', () => {
    const setup = vi.fn()
    const server = startable(new TestServer(logger, undefined, { plugins: [provider(memoryDb()), { setup }] }))

    void server.start()

    expect(setup).toHaveBeenCalled()
    return server.stop()
  })

  it('gives every plugin the database plugin\'s database, with their migrations run before setup', async () => {
    const db = memoryDb()
    let rows: unknown[] | undefined
    let ctxDb: unknown
    const server = startable(new TestServer(logger, undefined, {
      plugins: [
        { package: '@mavonengine/chat', options: {}, plugin: {
          migrations: mutes,
          setup: (ctx) => {
            ctxDb = ctx.db
            void ctx.db!.selectFrom(ctx.table('mutes')).selectAll().execute().then(result => (rows = result))
          },
        } },
        // The database plugin may come after the plugins that use it
        { package: '@mavonengine/sqlite', options: {}, plugin: provider(db) },
      ],
    }))

    await server.start()

    expect(server.db).toBe(db)
    expect(ctxDb).toBe(db)
    expect(server.databaseProvider).toBe('@mavonengine/sqlite')
    await vi.waitFor(() => expect(rows).toEqual([]))

    // GET /api/game/plugins tells which plugin gives the database
    const infos = server.pluginInfos()
    expect(infos.find(info => info.package === '@mavonengine/sqlite')?.database).toBe(true)
    expect(infos.find(info => info.package === '@mavonengine/chat')).not.toHaveProperty('database')
    await server.stop()
  })

  it('turns a plugin off when its migration fails, and runs the others', async () => {
    const error = vi.spyOn(logger, 'error')
    const brokenSetup = vi.fn()
    const brokenTick = vi.fn()
    const okSetup = vi.fn()
    const server = startable(new TestServer(logger, undefined, {
      plugins: [
        provider(memoryDb()),
        { package: 'broken', options: {}, plugin: {
          migrations: { '001': { up: async () => { throw new Error('nope') } } },
          setup: brokenSetup,
          tick: brokenTick,
        } },
        { package: 'chat', options: {}, plugin: { migrations: mutes, setup: okSetup } },
      ],
    }))

    await server.start()
    server.plugins!.run('tick', 0.1)

    expect(brokenSetup).not.toHaveBeenCalled()
    expect(brokenTick).not.toHaveBeenCalled()
    expect(okSetup).toHaveBeenCalled()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Plugin broken turned off: Migration 001 failed: nope'))
    await server.stop()
  })

  it('picks the database plugin from the options, the config or else the first', async () => {
    const a = memoryDb()
    const b = memoryDb()
    const plugins = [
      { package: 'db-a', options: {}, plugin: provider(a) },
      { package: 'db-b', options: {}, plugin: provider(b) },
    ]

    const warn = vi.spyOn(logger, 'warn')
    const first = startable(new TestServer(logger, undefined, { plugins }))
    await first.start()
    expect(first.db).toBe(a)
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('More than one database plugin is enabled (db-a, db-b), using db-a'))
    // Stopping would destroy them, which the next servers still use
    first.plugins = undefined

    const picked = startable(new TestServer(logger, undefined, { plugins, database: 'db-b' }))
    await picked.start()
    expect(picked.db).toBe(b)

    const root = tempProject()
    writeConfig(root, { plugins: {}, database: 'db-b' })
    const fromConfig = startable(new TestServer(logger, undefined, { plugins, root }))
    await fromConfig.start()
    expect(fromConfig.db).toBe(b)

    const error = vi.spyOn(logger, 'error')
    const missing = startable(new TestServer(logger, undefined, { plugins, database: 'db-c' }))
    await missing.start()
    expect(missing.db).toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Database plugin db-c is not running'))

    await a.destroy()
    await b.destroy()
  })

  it('only asks the picked database plugin for its database', async () => {
    const unused = vi.fn(() => memoryDb())
    const server = startable(new TestServer(logger, undefined, {
      plugins: [provider(memoryDb()), { name: 'other', database: unused }],
    }))

    await server.start()

    expect(unused).not.toHaveBeenCalled()
    await server.stop()
  })

  it('runs without a database when the database plugin gives none or throws', async () => {
    const error = vi.spyOn(logger, 'error')
    const server = startable(new TestServer(logger, undefined, {
      plugins: [{ name: 'sqlite', database: () => { throw new Error('cannot open file') } }],
    }))

    await server.start()

    expect(server.db).toBeUndefined()
    expect(error).toHaveBeenCalledWith(expect.stringContaining('cannot open file'))
    await server.stop()
  })

  it('closes the database when the server stops, after the plugins finished saving', async () => {
    const db = memoryDb()
    const destroy = vi.spyOn(db, 'destroy')
    const order: string[] = []
    const server = startable(new TestServer(logger, undefined, {
      plugins: [
        provider(db),
        { package: 'chat', options: {}, plugin: {
          migrations: mutes,
          async destroy(ctx) {
            await ctx.db!.insertInto(ctx.table('mutes')).values({ player: 'p1' }).execute()
            order.push('saved')
          },
        } },
        { name: 'failing', destroy: async () => { throw new Error('save failed') } },
      ],
    }))
    destroy.mockImplementation(async () => {
      order.push('destroyed')
    })

    await server.start()
    await server.stop()

    expect(order).toEqual(['saved', 'destroyed'])
    expect(server.db).toBeUndefined()
    destroy.mockRestore()
    await db.destroy()
  })

  it('loads database plugins from mavonengine.json', async () => {
    const root = tempProject()
    installPlugin(root, 'fake-sqlite', { target: 'server', server: './server.mjs' }, {
      'server.mjs': `export default { database: () => ({ marker: 'db', destroy: async () => {} }) }`,
    })
    writeConfig(root, { plugins: { 'fake-sqlite': {} } })

    const server = startable(new TestServer(logger, undefined, { plugins: { root } }))
    await server.start()

    expect(server.db).toEqual(expect.objectContaining({ marker: 'db' }))
    expect(server.databaseProvider).toBe('fake-sqlite')
    await server.stop()
  })
})
