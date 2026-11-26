import type { ServerChannel } from '@geckos.io/server'
import type { Kysely } from 'kysely'
import type { ServerPlugin, ServerPluginContext } from '../../src/Plugins/types'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import winston from 'winston'
import Player from '../../src/Networking/Entities/Player'
import Server from '../../src/Networking/Server/Server'
import { JOBS_TABLE } from '../../src/Queue/drivers/DatabaseQueueDriver'
import Job from '../../src/Queue/Job'
import { memoryDb } from '../Plugins/Database/memoryDb'

vi.mock('@geckos.io/server', () => ({
  default: vi.fn(() => ({
    onConnection: vi.fn(),
    connectionsManager: {
      connections: new Map(),
    },
    emit: vi.fn(),
    listen: vi.fn(),
  })),
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

const ran: unknown[] = []

class Greet extends Job<{ name: string }> {
  static jobName = 'test:greet'
  handle() {
    ran.push(this.data)
  }
}

function sqlite(db: Kysely<any>): ServerPlugin {
  return {
    name: 'sqlite',
    database: () => db,
  }
}

describe('server queue', () => {
  let logger: winston.Logger

  beforeEach(() => {
    logger = winston.createLogger({ transports: [], silent: true })
    ran.length = 0
  })

  function startable(server: TestServer) {
    vi.spyOn(server.http, 'start').mockImplementation(() => {})
    return server
  }

  it('keeps jobs in memory without a database plugin, and runs them once started', async () => {
    const server = startable(new TestServer(logger, undefined, { plugins: [], stopOnSignals: false }))
    await server.queue.dispatch(new Greet({ name: 'early' }))
    expect(ran).toEqual([])

    await server.start()

    expect(server.queue.driverName).toBe('memory')
    await vi.waitFor(() => expect(ran).toEqual([
      { name: 'early' },
    ]))
    await server.stop()
  })

  it('migrates its tables and keeps jobs in the database plugin\'s database, also those dispatched before start', async () => {
    const db = memoryDb()
    const server = startable(new TestServer(logger, undefined, {
      plugins: [
        sqlite(db),
      ],
      stopOnSignals: false,
      queue: { work: false },
    }))
    await server.queue.dispatch(new Greet({ name: 'early' }))

    await server.start()
    await server.queue.dispatch(new Greet({ name: 'later' }))

    expect(server.queue.driverName).toBe('database')
    const rows = await db.selectFrom(JOBS_TABLE).select('payload').orderBy('created_at').execute()
    expect(rows.map(row => JSON.parse(row.payload))).toEqual([
      { name: 'early' },
      { name: 'later' },
    ])
    // Not worked: `work: false`
    expect(ran).toEqual([])

    // The engine's tables show up as its own in the dashboard's Database tab
    expect(server.databasePlugins()).toContain('@mavonengine/core')

    await server.stop()
  })

  it('runs jobs queued in the database before a restart', async () => {
    const db = memoryDb()
    // destroy() of the first server's database would close it for the second, so it is left open
    const first = startable(new TestServer(logger, undefined, {
      plugins: [
        sqlite(db),
      ],
      stopOnSignals: false,
      queue: { work: false },
    }))
    await first.start()
    await first.queue.dispatch(new Greet({ name: 'before restart' }))

    const second = startable(new TestServer(logger, undefined, {
      plugins: [
        sqlite(db),
        {
          name: 'greeter',
          setup: ctx => void ctx.queue.register(Greet),
        },
      ],
      stopOnSignals: false,
      queue: { pollIntervalMs: 10 },
    }))
    await second.start()

    await vi.waitFor(() => expect(ran).toEqual([
      { name: 'before restart' },
    ]))
    await vi.waitFor(async () => expect(await second.queue.size()).toBe(0))
    await first.queue.stop()
    await second.stop()
  })

  it('stays in memory when told to, even with a database', async () => {
    const db = memoryDb()
    const server = startable(new TestServer(logger, undefined, {
      plugins: [
        sqlite(db),
      ],
      stopOnSignals: false,
      queue: { driver: 'memory' },
    }))
    await server.start()
    await server.queue.dispatch(new Greet({ name: 'x' }))

    expect(server.queue.driverName).toBe('memory')
    expect((await db.introspection.getTables()).map(table => table.name)).not.toContain(JOBS_TABLE)
    await server.stop()
  })

  it('warns when asked for the database without a database plugin', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const server = startable(new TestServer(logger, undefined, {
      plugins: [],
      stopOnSignals: false,
      queue: { driver: 'database' },
    }))
    await server.start()

    expect(server.queue.driverName).toBe('memory')
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('the project has no database plugin'))
    await server.stop()
  })

  it('gives plugins the queue', async () => {
    let ctx: ServerPluginContext | undefined
    const server = startable(new TestServer(logger, undefined, {
      plugins: [
        {
          name: 'p',
          setup: c => void (ctx = c),
        },
      ],
      stopOnSignals: false,
    }))
    await server.start()

    expect(ctx!.queue).toBe(server.queue)
    await ctx!.queue.dispatch(new Greet({ name: 'from a plugin' }))
    await vi.waitFor(() => expect(ran).toEqual([
      { name: 'from a plugin' },
    ]))
    await server.stop()
  })

  it('closes the database only once the running jobs finished', async () => {
    const db = memoryDb()
    const order: string[] = []
    let finish!: () => void
    class Saving extends Job<null> {
      static jobName = 'test:saving'
      async handle() {
        await new Promise<void>(resolve => (finish = resolve))
        await db.selectFrom(JOBS_TABLE).selectAll().execute()
        order.push('job done')
      }
    }
    const destroy = vi.spyOn(db, 'destroy').mockImplementation(async () => void order.push('db closed'))

    const server = startable(new TestServer(logger, undefined, {
      plugins: [
        sqlite(db),
      ],
      stopOnSignals: false,
    }))
    await server.start()
    await server.queue.dispatch(new Saving(null))
    await vi.waitFor(() => expect(finish).toBeDefined())

    const stopping = server.stop()
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(destroy).not.toHaveBeenCalled()

    finish()
    await stopping
    expect(order).toEqual(['job done', 'db closed'])
    destroy.mockRestore()
    await db.destroy()
  })
})
