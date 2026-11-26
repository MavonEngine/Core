import type { FailedJob, QueuedJob, QueueDriver, ReserveOptions } from './QueueDriver'

/** How many failed jobs the memory driver keeps, dropping the oldest */
export const MEMORY_FAILED_LIMIT = 100

/**
 * Keeps the jobs in this process: they are gone when it stops. The queue's driver when the project has no database.
 */
export default class MemoryQueueDriver implements QueueDriver {
  readonly name = 'memory'

  private jobs = new Map<string, QueuedJob & { reservedAt?: number }>()
  private failedJobs: FailedJob[] = []

  async push(job: QueuedJob): Promise<void> {
    this.jobs.set(job.id, { ...job })
  }

  async reserve({ names, queues, now, staleBefore }: ReserveOptions): Promise<QueuedJob | undefined> {
    let next: (QueuedJob & { reservedAt?: number }) | undefined
    for (const job of this.jobs.values()) {
      if (job.availableAt > now || !names.includes(job.name) || (queues && !queues.includes(job.queue)))
        continue
      if (job.reservedAt !== undefined && job.reservedAt > staleBefore)
        continue
      if (!next || job.availableAt < next.availableAt || (job.availableAt === next.availableAt && job.createdAt < next.createdAt))
        next = job
    }

    if (!next)
      return undefined

    next.reservedAt = now
    next.attempts++
    const { reservedAt: _reservedAt, ...job } = next
    return job
  }

  async delete(id: string): Promise<void> {
    this.jobs.delete(id)
  }

  async release(id: string, availableAt: number): Promise<void> {
    const job = this.jobs.get(id)
    if (!job)
      return
    job.reservedAt = undefined
    job.availableAt = availableAt
  }

  async fail(job: QueuedJob, error: string, failedAt: number): Promise<void> {
    this.jobs.delete(job.id)
    this.failedJobs.unshift({
      id: job.id,
      queue: job.queue,
      name: job.name,
      payload: job.payload,
      attempts: job.attempts,
      error,
      failedAt,
    })
    this.failedJobs.length = Math.min(this.failedJobs.length, MEMORY_FAILED_LIMIT)
  }

  async size(queue?: string): Promise<number> {
    if (queue === undefined)
      return this.jobs.size
    return [
      ...this.jobs.values(),
    ].filter(job => job.queue === queue).length
  }

  async failed(limit: number): Promise<FailedJob[]> {
    return this.failedJobs.slice(0, limit).map(job => ({ ...job }))
  }

  async retry(id: string, now: number): Promise<boolean> {
    const index = this.failedJobs.findIndex(job => job.id === id)
    if (index < 0)
      return false
    const [failed] = this.failedJobs.splice(index, 1)
    this.jobs.set(id, {
      id,
      queue: failed.queue,
      name: failed.name,
      payload: failed.payload,
      attempts: 0,
      availableAt: now,
      createdAt: now,
    })
    return true
  }

  async forget(id: string): Promise<boolean> {
    const before = this.failedJobs.length
    this.failedJobs = this.failedJobs.filter(job => job.id !== id)
    return this.failedJobs.length < before
  }

  /** Take every waiting job out, to move them to another driver */
  takeAll(): QueuedJob[] {
    const jobs = Array.from(this.jobs.values(), ({ reservedAt: _reservedAt, ...job }) => job)
    this.jobs.clear()
    return jobs
  }
}
