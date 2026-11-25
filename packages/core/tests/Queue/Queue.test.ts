import type { Kysely } from 'kysely'
import type { QueueDriver } from '../../src/Queue/drivers/QueueDriver'
import type { JobContext } from '../../src/Queue/Job'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { runPluginMigrations } from '../../src/Plugins/Database/migrate'
import DatabaseQueueDriver, { FAILED_JOBS_TABLE, JOBS_TABLE, QUEUE_PACKAGE, queueMigrations } from '../../src/Queue/drivers/DatabaseQueueDriver'
import MemoryQueueDriver from '../../src/Queue/drivers/MemoryQueueDriver'
import Job, { backoffAfter } from '../../src/Queue/Job'
import Queue from '../../src/Queue/Queue'
import { memoryDb } from '../Plugins/Database/memoryDb'

const runs: { data: unknown, ctx: JobContext }[] = []

class Record extends Job<{ n: number }> {
  static jobName = 'record'
  handle(ctx: JobContext) {
    runs.push({ data: this.data, ctx })
  }
}

let failures = 0
const failedCalls: { error: Error, ctx: JobContext }[] = []

/** Throws on its first `failures` tries */
class Flaky extends Job<string> {
  static jobName = 'flaky'
  tries = 3
  handle(ctx: JobContext) {
    if (ctx.attempt <= failures)
      throw new Error(`try ${ctx.attempt} broke`)
    runs.push({ data: this.data, ctx })
  }

  failed(error: Error, ctx: JobContext) {
    failedCalls.push({ error, ctx })
  }
}

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}
const queues: Queue[] = []
const dbs: Kysely<any>[] = []

afterEach(async () => {
  await Promise.all(queues.splice(0).map(queue => queue.stop()))
  await Promise.all(dbs.splice(0).map(db => db.destroy()))
  runs.length = 0
  failedCalls.length = 0
  failures = 0
  vi.useRealTimers()
  vi.clearAllMocks()
})

async function databaseDriver(): Promise<DatabaseQueueDriver> {
  const db = memoryDb()
  dbs.push(db)
  await runPluginMigrations(db, QUEUE_PACKAGE, queueMigrations)
  return new DatabaseQueueDriver(db)
}

const drivers: [string, () => Promise<QueueDriver>][] = [
  [
    'memory',
    async () => new MemoryQueueDriver(),
  ],
  ['database', databaseDriver],
]

describe.each(drivers)('queue on the %s driver', (_name, makeDriver) => {
  async function queue(options: ConstructorParameters<typeof Queue>[1] = {}) {
    const q = new Queue(logger, { pollIntervalMs: 10, ...options })
    await q.use(await makeDriver())
    queues.push(q)
    return q
  }

  it('runs a dispatched job with its data, then takes it off the queue', async () => {
    const q = await queue()
    q.start()

    const id = await q.dispatch(new Record({ n: 1 }))

    await vi.waitFor(() => expect(runs).toEqual([
      {
        data: { n: 1 },
        ctx: { id, queue: 'default', attempt: 1 },
      },
    ]))
    await vi.waitFor(async () => expect(await q.size()).toBe(0))
  })

  it('keeps jobs dispatched while it isn\'t working, and runs them in the order they were dispatched', async () => {
    const q = await queue()
    await q.dispatch(new Record({ n: 1 }))
    await new Promise(resolve => setTimeout(resolve, 2))
    await q.dispatch(new Record({ n: 2 }))
    expect(await q.size()).toBe(2)
    expect(runs).toEqual([])

    q.start()

    await vi.waitFor(() => expect(runs.map(run => run.data)).toEqual([
      { n: 1 },
      { n: 2 },
    ]))
  })

  it('waits for a delayed job', async () => {
    const q = await queue()
    q.start()

    const dispatched = Date.now()
    await q.dispatch(new Record({ n: 1 }), { delayMs: 80 })
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(runs).toEqual([])

    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(Date.now() - dispatched).toBeGreaterThanOrEqual(75)
  })

  it('tries a failing job again, and counts the tries', async () => {
    failures = 2
    const q = await queue()
    q.start()

    await q.dispatch(new Flaky('x'))

    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0].ctx.attempt).toBe(3)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('failed try 1 of 3'))
    expect(await q.failed()).toEqual([])
    expect(failedCalls).toEqual([])
  })

  it('keeps a job that ran out of tries among the failed ones, calls its failed(), and can retry it', async () => {
    failures = 3
    const q = await queue()
    q.start()

    const id = await q.dispatch(new Flaky('x'), { queue: 'rewards' })

    await vi.waitFor(() => expect(failedCalls).toHaveLength(1))
    expect(failedCalls[0].error.message).toBe('try 3 broke')
    expect(failedCalls[0].ctx).toEqual({ id, queue: 'rewards', attempt: 3 })

    const [failed] = await q.failed()
    expect(failed).toMatchObject({
      id,
      queue: 'rewards',
      name: 'flaky',
      payload: '"x"',
      attempts: 3,
    })
    expect(failed.error).toContain('try 3 broke')
    expect(await q.size()).toBe(0)
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining(`Job flaky (${id}) failed all 3 tries`))

    failures = 0
    expect(await q.retry(id)).toBe(true)
    await vi.waitFor(() => expect(runs).toHaveLength(1))
    expect(runs[0].ctx).toEqual({ id, queue: 'rewards', attempt: 1 })
    expect(await q.failed()).toEqual([])
    expect(await q.retry(id)).toBe(false)
  })

  it('forgets a failed job', async () => {
    failures = 3
    const q = await queue()
    q.start()
    const id = await q.dispatch(new Flaky('x'))
    await vi.waitFor(async () => expect(await q.failed()).toHaveLength(1))

    expect(await q.forget(id)).toBe(true)
    expect(await q.failed()).toEqual([])
    expect(await q.forget(id)).toBe(false)
  })

  it('works the queues it is given, the first first, and leaves the others', async () => {
    const q = await queue({
      queues: ['high', 'default'],
    })
    await q.dispatch(new Record({ n: 1 }))
    await q.dispatch(new Record({ n: 2 }), { queue: 'other' })
    await q.dispatch(new Record({ n: 3 }), { queue: 'high' })

    q.start()

    await vi.waitFor(() => expect(runs.map(run => run.data)).toEqual([
      { n: 3 },
      { n: 1 },
    ]))
    expect(await q.size('other')).toBe(1)
  })

  it('runs up to `concurrency` jobs at the same time', async () => {
    let active = 0
    let most = 0
    class Slow extends Job<null> {
      static jobName = 'slow'
      async handle() {
        most = Math.max(most, ++active)
        await new Promise(resolve => setTimeout(resolve, 20))
        active--
        runs.push({ data: null, ctx: undefined as never })
      }
    }

    const q = await queue({ concurrency: 2 })
    for (let i = 0; i < 5; i++)
      await q.dispatch(new Slow(null))
    q.start()

    await vi.waitFor(() => expect(runs).toHaveLength(5))
    expect(most).toBe(2)
  })

  it('leaves jobs without a registered class on the queue, and runs them once it is registered', async () => {
    const driver = await makeDriver()
    const first = new Queue(logger, { pollIntervalMs: 10 })
    await first.use(driver)
    await first.dispatch(new Record({ n: 1 }))

    // Another process on the same jobs, like the server after a restart
    const second = new Queue(logger, { pollIntervalMs: 10 })
    queues.push(second)
    await second.use(driver)
    second.start()
    await new Promise(resolve => setTimeout(resolve, 30))
    expect(runs).toEqual([])
    expect(await second.size()).toBe(1)

    second.register(Record)

    await vi.waitFor(() => expect(runs).toHaveLength(1))
  })

  it('runs a job taken by a worker that died again once `retryAfterMs` passed', async () => {
    const driver = await makeDriver()
    const id = 'abandoned'
    await driver.push({
      id,
      queue: 'default',
      name: 'record',
      payload: '{"n":1}',
      attempts: 0,
      availableAt: 0,
      createdAt: 0,
    })
    const now = Date.now()
    expect(await driver.reserve({
      names: ['record'],
      now,
      staleBefore: now - 1000,
    })).toMatchObject({ id, attempts: 1 })
    // Reserved, so not taken again yet
    expect(await driver.reserve({
      names: ['record'],
      now,
      staleBefore: now - 1000,
    })).toBeUndefined()

    const q = new Queue(logger, { pollIntervalMs: 10, retryAfterMs: 50 }).register(Record)
    queues.push(q)
    await q.use(driver)
    q.start()

    await vi.waitFor(() => expect(runs).toEqual([
      {
        data: { n: 1 },
        ctx: { id, queue: 'default', attempt: 2 },
      },
    ]))
  })

  it('waits for running jobs when it stops, and takes no more', async () => {
    let finish!: () => void
    class Blocking extends Job<null> {
      static jobName = 'blocking'
      handle() {
        return new Promise<void>(resolve => (finish = resolve))
      }
    }

    const q = await queue()
    q.start()
    await q.dispatch(new Blocking(null))
    await vi.waitFor(() => expect(finish).toBeDefined())

    let stopped = false
    const stopping = q.stop().then(() => (stopped = true))
    await q.dispatch(new Record({ n: 1 }))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(stopped).toBe(false)

    finish()
    await stopping
    expect(runs).toEqual([])
    expect(await q.size()).toBe(1)
  })
})

describe('queue', () => {
  it('moves jobs dispatched before it switched driver to the new one', async () => {
    const q = new Queue(logger)
    queues.push(q)
    let open!: (driver: QueueDriver) => void
    const switching = q.use(new Promise<QueueDriver>(resolve => (open = resolve)))

    // Before the switch: stored once the new driver is there
    const dispatching = q.dispatch(new Record({ n: 1 }))
    const driver = await databaseDriver()
    open(driver)
    await switching
    await dispatching

    expect(q.driverName).toBe('database')
    expect(await driver.size()).toBe(1)
  })

  it('stores jobs dispatched before the switch began in the new driver', async () => {
    const q = new Queue(logger)
    queues.push(q)
    await q.dispatch(new Record({ n: 1 }))

    const driver = await databaseDriver()
    await q.use(driver)

    expect(await driver.size()).toBe(1)
    const rows = await (driver as unknown as { db: Kysely<any> }).db.selectFrom(JOBS_TABLE).selectAll().execute()
    expect(rows).toEqual([
      expect.objectContaining({
        name: 'record',
        payload: '{"n":1}',
        queue: 'default',
        attempts: 0,
        reserved_at: null,
      }),
    ])
  })

  it('keeps its driver when the new one doesn\'t come', async () => {
    const q = new Queue(logger)
    await q.use(Promise.reject(new Error('no database')))
    expect(q.driverName).toBe('memory')
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('no database'))

    await q.use(Promise.resolve(undefined))
    expect(q.driverName).toBe('memory')
  })

  it('runs a job right away with dispatchSync, passing its throw on', async () => {
    const q = new Queue(logger)
    await q.dispatchSync(new Record({ n: 1 }))
    expect(runs).toHaveLength(1)
    expect(await q.size()).toBe(0)

    failures = 1
    await expect(q.dispatchSync(new Flaky('x'))).rejects.toThrow('try 1 broke')
    expect(await q.failed()).toEqual([])
  })

  it('refuses two classes with one name', () => {
    class Other extends Job<null> {
      static jobName = 'record'
      handle() {}
    }

    const q = new Queue(logger).register(Record)
    expect(() => q.register(Other)).toThrow('Another job class is registered as "record"')
    return expect(q.dispatch(new Other(null))).rejects.toThrow('Another job class')
  })

  it('names a job after its class without a jobName', async () => {
    class GrantReward extends Job<null> {
      handle() {}
    }

    const q = new Queue(logger)
    await q.dispatch(new GrantReward(null))
    expect(q.has('GrantReward')).toBe(true)
  })

  it('refuses data that isn\'t JSON', async () => {
    const q = new Queue(logger)
    await expect(q.dispatch(new Record(() => {}) as unknown as Job)).rejects.toThrow('can\'t be stored as JSON')
  })

  it('puts the migrated tables under the core prefix', async () => {
    const db = memoryDb()
    dbs.push(db)
    expect(await runPluginMigrations(db, QUEUE_PACKAGE, queueMigrations)).toEqual(['001_create_jobs'])
    const tables = (await db.introspection.getTables()).map(table => table.name).sort()
    expect(tables).toEqual(['core__migrations', FAILED_JOBS_TABLE, JOBS_TABLE].sort())
    expect(JOBS_TABLE).toBe('core_jobs')
    expect(FAILED_JOBS_TABLE).toBe('core_failed_jobs')
  })
})

describe('backoffAfter', () => {
  it('waits the one delay after every try, or the delay of that try with the last repeating', () => {
    expect(backoffAfter(500, 1)).toBe(500)
    expect(backoffAfter(500, 4)).toBe(500)
    expect(backoffAfter([100, 200], 1)).toBe(100)
    expect(backoffAfter([100, 200], 2)).toBe(200)
    expect(backoffAfter([100, 200], 5)).toBe(200)
    expect(backoffAfter([], 1)).toBe(0)
    expect(backoffAfter(-5, 1)).toBe(0)
  })
})
