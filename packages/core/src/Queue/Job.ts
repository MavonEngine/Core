/**
 * What a job is told about the run it is in
 */
export interface JobContext {
  /** Id of the queued job, the same over its retries */
  readonly id: string
  /** Queue it was taken from */
  readonly queue: string
  /** Which try this is, 1 on the first */
  readonly attempt: number
}

/**
 * A unit of work to run later, on the server's queue. Extend it and implement `handle()`:
 *
 * ```ts
 * class GrantReward extends Job<{ player: string, coins: number }> {
 *   static jobName = 'grant-reward'
 *   tries = 3
 *   backoffMs = [1000, 5000]
 *
 *   async handle() {
 *     await addCoins(this.data.player, this.data.coins)
 *   }
 * }
 *
 * server.queue.dispatch(new GrantReward({ player: id, coins: 10 }))
 * ```
 *
 * `data` is stored as JSON, so keep it to what JSON keeps: ids rather than entities or connections. The job is built
 * again from it, with `new GrantReward(data)`, when it runs, also after a restart when the queue is in the database.
 */
export default abstract class Job<TData = unknown> {
  /**
   * Name the job is stored and looked up by. Defaults to the class name. Set it so that renaming the class (or a
   * bundler renaming it) doesn't leave jobs already queued without a class to run them. Plugins: prefix it with
   * the plugin's name, e.g. `chat:expire-mute`, so jobs of different plugins don't clash.
   */
  static jobName?: string

  /** Queue it goes on, unless `dispatch()` says otherwise */
  queue = 'default'

  /** How often it is tried before it counts as failed. At least 1 */
  tries = 1

  /**
   * How long to wait before trying again, in ms: one number for every retry, or one per retry, the last repeating
   * for any further ones, e.g. `[1000, 10_000, 60_000]`
   */
  backoffMs: number | number[] = 0

  constructor(readonly data: TData) {}

  /** Do the work. A throw (or a rejection) is a failed try: it is tried again while it has `tries` left */
  abstract handle(ctx: JobContext): void | Promise<void>

  /** Called once it failed for good, with the error of its last try */
  failed?(error: Error, ctx: JobContext): void | Promise<void>
}

/** A job class, as given to `queue.register()` */
export type JobClass<T extends Job<any> = Job<any>> = (new (data: any) => T) & { readonly name: string, jobName?: string }

/** The name a job class is stored under */
export function jobNameOf(job: JobClass): string {
  const name = job.jobName ?? job.name
  if (!name)
    throw new Error('A job class needs a name: set its static jobName')
  return name
}

/** How long to wait before the retry after try `attempt` (1-based) */
export function backoffAfter(backoffMs: number | number[], attempt: number): number {
  const delay = Array.isArray(backoffMs)
    ? backoffMs[Math.min(attempt, backoffMs.length) - 1]
    : backoffMs
  return typeof delay === 'number' && Number.isFinite(delay) && delay > 0
    ? delay
    : 0
}
