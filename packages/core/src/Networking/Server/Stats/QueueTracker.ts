import type { QueueCounters } from '../../../Queue/Queue'

export interface QueueSample {
  timestamp: number
  /** Jobs on the queue that didn't finish, also the delayed and running ones, as last counted */
  size: number
  /** Jobs this server was running */
  running: number
  /** Jobs that finished in the sample window */
  processed: number
  /** Tries that threw and were put back in the sample window */
  retried: number
  /** Jobs that ran out of tries in the sample window */
  failed: number
}

/** What the tracker reads of the queue */
export interface QueueSource {
  readonly driverName: string
  readonly isWorking: boolean
  readonly runningCount: number
  readonly counters: Readonly<QueueCounters>
  size(): Promise<number>
}

/**
 * Samples the server's queue for the metrics: how many jobs wait, and how many ran and failed per window.
 * Counting the jobs can take a database query, so a sample has the count the previous one asked for.
 */
export default class QueueTracker {
  readonly history: QueueSample[] = []

  private last: QueueCounters = { processed: 0, retried: 0, failed: 0 }
  private size = 0
  private counting = false

  constructor(private queue: QueueSource, private historyLength = 60) {
    this.count()
  }

  get driver(): string {
    return this.queue.driverName
  }

  get working(): boolean {
    return this.queue.isWorking
  }

  get latest(): QueueSample | undefined {
    return this.history.at(-1)
  }

  sample(now = Date.now()): QueueSample {
    const counters = this.queue.counters
    const sample: QueueSample = {
      timestamp: now,
      size: this.size,
      running: this.queue.runningCount,
      processed: counters.processed - this.last.processed,
      retried: counters.retried - this.last.retried,
      failed: counters.failed - this.last.failed,
    }
    this.last = { ...counters }

    this.history.push(sample)
    if (this.history.length > this.historyLength)
      this.history.splice(0, this.history.length - this.historyLength)

    this.count()
    return sample
  }

  /** Ask for the number of jobs, for the next sample. A count that fails keeps the last one */
  private count() {
    if (this.counting)
      return
    this.counting = true
    this.queue.size()
      .then(size => (this.size = size), () => {})
      .finally(() => (this.counting = false))
  }
}
