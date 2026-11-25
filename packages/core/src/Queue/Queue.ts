import type { FailedJob, QueuedJob, QueueDriver } from './drivers/QueueDriver'
import type Job from './Job'
import type { JobClass, JobContext } from './Job'
import { randomUUID } from 'node:crypto'
import MemoryQueueDriver from './drivers/MemoryQueueDriver'
import { backoffAfter, jobNameOf } from './Job'

export interface QueueOptions {
  /**
   * Where jobs are kept. `database` keeps them in the server's database (tables `core_jobs` and `core_failed_jobs`),
   * so they survive a restart; `memory` keeps them in the process. Default: `database` when the project has a
   * database plugin, else `memory`.
   */
  driver?: 'memory' | 'database'
  /** Run the jobs in this process. Turn it off on a server that only dispatches. Default true */
  work?: boolean
  /** How many jobs run at the same time. Default 1 */
  concurrency?: number
  /**
   * The queues to work, the first first: a job on `default` only runs while `high` has none due with
   * `['high', 'default']`. Default: every queue, the job that is due longest first.
   */
  queues?: string[]
  /** How often the worker looks for due jobs when it has nothing to do, in ms. Default 1000 */
  pollIntervalMs?: number
  /**
   * A job still running after this long is taken to be abandoned, e.g. because the server running it was killed,
   * and is run again. Keep it above the longest a job takes. Default 90000
   */
  retryAfterMs?: number
}

/** What a queue did since it was made, for the server's metrics */
export interface QueueCounters {
  /** Jobs that ran without a throw */
  processed: number
  /** Tries that threw and were put back to be tried again */
  retried: number
  /** Jobs that ran out of tries */
  failed: number
}

export interface DispatchOptions {
  /** Queue to put it on, instead of the job's `queue` */
  queue?: string
  /** Wait this long before running it, in ms */
  delayMs?: number
}

interface QueueLogger {
  info(message: string): unknown
  warn(message: string): unknown
  error(message: string): unknown
}

const DEFAULT_POLL_INTERVAL_MS = 1000
const DEFAULT_RETRY_AFTER_MS = 90_000

/**
 * Jobs to run in the background of the server: `queue.dispatch(new SendReward(data))`. The server's is
 * `server.queue`, and plugins have it as `ctx.queue`.
 *
 * Jobs run in the server's process, `concurrency` at a time. A job that throws is tried again after its `backoffMs`
 * while it has `tries` left, then it is kept among the failed jobs (`failed()`), and its `failed()` is called.
 */
export default class Queue {
  private classes = new Map<string, JobClass>()
  private driver: QueueDriver = new MemoryQueueDriver()
  /** Settles once the driver is the one to use, e.g. after the database's migration ran */
  private ready: Promise<void> = Promise.resolve()

  private working = false
  private filling = false
  private fillAgain = false
  private running = new Set<Promise<void>>()
  private done: QueueCounters = { processed: 0, retried: 0, failed: 0 }
  private poller?: ReturnType<typeof setInterval>
  private wakeups = new Set<ReturnType<typeof setTimeout>>()

  constructor(private logger?: QueueLogger | null, readonly options: QueueOptions = {}) {}

  /** `memory` or `database` */
  get driverName(): string {
    return this.driver.name
  }

  /** Whether this process runs jobs */
  /** How many jobs this process runs right now */
  get runningCount(): number {
    return this.running.size
  }

  /** Jobs this process ran, retried and failed so far */
  get counters(): Readonly<QueueCounters> {
    return { ...this.done }
  }

  get isWorking(): boolean {
    return this.working
  }

  /**
   * Make job classes runnable here. Jobs this process dispatches register their class themselves, but jobs that were
   * queued before a restart (in the database) only run once their class is registered: register them at startup,
   * e.g. in a plugin's `setup()`. Jobs whose class isn't registered wait on the queue.
   */
  register(...jobs: JobClass[]): this {
    for (const job of jobs) {
      const name = jobNameOf(job)
      const known = this.classes.get(name)
      if (known && known !== job)
        throw new Error(`Another job class is registered as ${JSON.stringify(name)}: set a different static jobName on one of them`)
      this.classes.set(name, job)
    }
    if (jobs.length)
      this.wake()
    return this
  }

  /** Whether a job class is registered under `name` */
  has(name: string): boolean {
    return this.classes.has(name)
  }

  /**
   * Put a job on the queue and return its id. The promise settles once it is stored, not once it ran.
   */
  async dispatch(job: Job<any>, options: DispatchOptions = {}): Promise<string> {
    const name = this.registerOwnClass(job)
    const now = Date.now()
    const delay = Math.max(0, options.delayMs ?? 0)
    const queued: QueuedJob = {
      id: randomUUID(),
      queue: options.queue ?? job.queue ?? 'default',
      name,
      payload: serialize(job.data, name),
      attempts: 0,
      availableAt: now + delay,
      createdAt: now,
    }

    await this.ready
    await this.driver.push(queued)

    if (delay > 0)
      this.wakeAfter(delay)
    else
      this.wake()

    return queued.id
  }

  /**
   * Run a job now, in this call, without the queue: no retries, and a throw is passed on rather than kept as failed.
   */
  async dispatchSync(job: Job<any>): Promise<void> {
    await job.handle({
      id: randomUUID(),
      queue: job.queue ?? 'default',
      attempt: 1,
    })
  }

  /** Number of jobs on `queue` (or on all queues) that didn't finish yet, also the delayed and running ones */
  async size(queue?: string): Promise<number> {
    await this.ready
    return this.driver.size(queue)
  }

  /** Jobs that ran out of tries, the latest first */
  async failed(limit = 50): Promise<FailedJob[]> {
    await this.ready
    return this.driver.failed(limit)
  }

  /** Put a failed job back on its queue, to be tried `tries` times again. False when there is no such failed job */
  async retry(id: string): Promise<boolean> {
    await this.ready
    const retried = await this.driver.retry(id, Date.now())
    if (retried)
      this.wake()
    return retried
  }

  /** Forget a failed job. False when there is no such failed job */
  async forget(id: string): Promise<boolean> {
    await this.ready
    return this.driver.forget(id)
  }

  /**
   * Switch to the driver `driver` gives, once it does (undefined keeps the current one). Jobs dispatched to the
   * memory driver until then move over. The server does this when it opened the database.
   */
  use(driver: QueueDriver | Promise<QueueDriver | undefined>): Promise<void> {
    const previous = this.ready
    this.ready = previous.then(() => driver).then(async (next) => {
      if (!next || next === this.driver)
        return

      const before = this.driver
      if (before instanceof MemoryQueueDriver) {
        for (const job of before.takeAll())
          await next.push(job)
      }
      this.driver = next
    }).catch((err: Error) => {
      this.logger?.error(`Queue: could not switch to the new driver, keeping the ${this.driver.name} one: ${err?.stack ?? err}`)
    })
    return this.ready
  }

  /** Start running jobs in this process */
  start(): void {
    if (this.working)
      return

    this.working = true
    this.poller = setInterval(() => this.fill(), this.options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS)
    this.poller.unref?.()
    this.fill()
  }

  /** Stop taking jobs off the queue. The returned promise settles once the running ones finished */
  stop(): Promise<void> {
    this.working = false
    clearInterval(this.poller)
    this.poller = undefined
    this.wakeups.forEach(timer => clearTimeout(timer))
    this.wakeups.clear()
    // Also waits for a driver switch underway, which may still be migrating the database
    return Promise.allSettled([this.ready, ...this.running]).then(() => {})
  }

  private registerOwnClass(job: Job<any>): string {
    const jobClass = job.constructor as JobClass
    const name = jobNameOf(jobClass)
    const known = this.classes.get(name)
    if (known && known !== jobClass)
      throw new Error(`Another job class is registered as ${JSON.stringify(name)}: set a different static jobName on one of them`)
    this.classes.set(name, jobClass)
    return name
  }

  private wake() {
    if (this.working)
      this.fill()
  }

  private wakeAfter(delayMs: number) {
    if (!this.working)
      return
    const timer = setTimeout(() => {
      this.wakeups.delete(timer)
      this.wake()
    }, delayMs)
    timer.unref?.()
    this.wakeups.add(timer)
  }

  /** Take due jobs off the queue until `concurrency` run or none is due */
  private fill() {
    if (this.filling) {
      this.fillAgain = true
      return
    }

    this.filling = true
    void this.fillLoop().finally(() => {
      this.filling = false
      if (this.fillAgain && this.working) {
        this.fillAgain = false
        this.fill()
      }
    })
  }

  private async fillLoop() {
    try {
      await this.ready
      const concurrency = Math.max(1, this.options.concurrency ?? 1)
      while (this.working && this.running.size < concurrency) {
        const job = await this.reserveNext()
        if (!job)
          return

        const run = this.run(job, this.driver).finally(() => {
          this.running.delete(run)
          this.wake()
        })
        this.running.add(run)
      }
    }
    catch (err) {
      this.logger?.error(`Queue: could not take a job off the ${this.driver.name} queue: ${(err as Error)?.stack ?? err}`)
    }
  }

  private async reserveNext(): Promise<QueuedJob | undefined> {
    const names = [
      ...this.classes.keys(),
    ]
    if (names.length === 0)
      return undefined

    const now = Date.now()
    const staleBefore = now - (this.options.retryAfterMs ?? DEFAULT_RETRY_AFTER_MS)
    const queues = this.options.queues
    if (!queues)
      return this.driver.reserve({ names, now, staleBefore })

    for (const queue of queues) {
      const job = await this.driver.reserve({
        names,
        queues: [queue],
        now,
        staleBefore,
      })
      if (job)
        return job
    }
    return undefined
  }

  private async run(queued: QueuedJob, driver: QueueDriver) {
    const ctx: JobContext = { id: queued.id, queue: queued.queue, attempt: queued.attempts }
    let job: Job<any> | undefined

    try {
      const Constructor = this.classes.get(queued.name)
      if (!Constructor)
        throw new Error(`No job class is registered as ${JSON.stringify(queued.name)}`)

      job = new Constructor(JSON.parse(queued.payload))
      await job.handle(ctx)
    }
    catch (err) {
      await this.failedTry(queued, driver, job, toError(err), ctx)
      return
    }

    this.done.processed++
    try {
      await driver.delete(queued.id)
    }
    catch (err) {
      this.logger?.error(`Queue: job ${queued.name} (${queued.id}) ran, but could not be taken off the queue, so it may run again: ${(err as Error)?.stack ?? err}`)
    }
  }

  private async failedTry(queued: QueuedJob, driver: QueueDriver, job: Job<any> | undefined, error: Error, ctx: JobContext) {
    const tries = Math.max(1, Math.floor(job?.tries ?? 1))
    const label = `Job ${queued.name} (${queued.id})`

    try {
      if (job && queued.attempts < tries) {
        const delay = backoffAfter(job.backoffMs, queued.attempts)
        await driver.release(queued.id, Date.now() + delay)
        this.done.retried++
        this.logger?.warn(`${label} failed try ${queued.attempts} of ${tries}, trying again${delay
          ? ` in ${delay} ms`
          : ''}: ${error.message}`)
        if (delay > 0)
          this.wakeAfter(delay)
        return
      }

      await driver.fail(queued, error.stack ?? error.message, Date.now())
      this.done.failed++
      this.logger?.error(`${label} failed${tries > 1
        ? ` all ${tries} tries`
        : ''}: ${error.stack ?? error.message}`)
    }
    catch (err) {
      this.logger?.error(`Queue: could not record that ${label} failed: ${(err as Error)?.stack ?? err}`)
      return
    }

    try {
      await job?.failed?.(error, ctx)
    }
    catch (err) {
      this.logger?.error(`${label} threw in failed(): ${(err as Error)?.stack ?? err}`)
    }
  }
}

function serialize(data: unknown, name: string): string {
  const json = JSON.stringify(data ?? null)
  if (json === undefined)
    throw new TypeError(`The data of job ${name} can't be stored as JSON`)
  return json
}

function toError(err: unknown): Error {
  return err instanceof Error
    ? err
    : new Error(String(err))
}
