/** A job waiting on the queue, or being run */
export interface QueuedJob {
  id: string
  queue: string
  /** The job class's `jobName` */
  name: string
  /** The job's `data`, as JSON */
  payload: string
  /** How often it was taken off the queue to run, including the current run */
  attempts: number
  /** When it may run, ms since the epoch */
  availableAt: number
  createdAt: number
}

/** A job that ran out of tries */
export interface FailedJob {
  id: string
  queue: string
  name: string
  payload: string
  attempts: number
  /** The error of its last try, with its stack */
  error: string
  failedAt: number
}

export interface ReserveOptions {
  /** Only jobs of these names, the ones this process has a class for */
  names: string[]
  /** Only jobs on one of these queues. Any queue when undefined */
  queues?: string[]
  now: number
  /** A job reserved before this is taken as abandoned (its process died) and may be reserved again */
  staleBefore: number
}

/**
 * Where a queue keeps its jobs. All methods may be called concurrently.
 */
export interface QueueDriver {
  readonly name: string
  push(job: QueuedJob): Promise<void>
  /**
   * Claim the next job that is due, the one available longest, so no other worker takes it, and count the attempt.
   * Undefined when there is none.
   */
  reserve(options: ReserveOptions): Promise<QueuedJob | undefined>
  /** The job is done */
  delete(id: string): Promise<void>
  /** Put a reserved job back, to run again from `availableAt` */
  release(id: string, availableAt: number): Promise<void>
  /** Take a job off the queue and keep it among the failed ones */
  fail(job: QueuedJob, error: string, failedAt: number): Promise<void>
  /** Number of jobs on `queue` (or all queues), also the delayed and running ones */
  size(queue?: string): Promise<number>
  /** The failed jobs, the latest first */
  failed(limit: number): Promise<FailedJob[]>
  /** Put a failed job back on its queue, with its attempts reset. False when there is no such failed job */
  retry(id: string, now: number): Promise<boolean>
  /** Forget a failed job. False when there is no such failed job */
  forget(id: string): Promise<boolean>
}
