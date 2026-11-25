import type { JobContext } from '../../../../src/Queue/Job'
import { describe, expect, it, vi } from 'vitest'
import winston from 'winston'
import BaseGame from '../../../../src/BaseGame'
import QueueTracker from '../../../../src/Networking/Server/Stats/QueueTracker'
import ServerMetrics from '../../../../src/Networking/Server/Stats/ServerMetrics'
import ServerWorld from '../../../../src/Networking/Server/World'
import Job from '../../../../src/Queue/Job'
import Queue from '../../../../src/Queue/Queue'

class Work extends Job<{ fail?: boolean }> {
  static jobName = 'work'
  tries = 2
  handle(_ctx: JobContext) {
    if (this.data.fail)
      throw new Error('broke')
  }
}

describe('queueTracker', () => {
  it('samples how many jobs wait, and how many ran, were retried and failed in each window', async () => {
    const queue = new Queue(null, { pollIntervalMs: 10 })
    const tracker = new QueueTracker(queue, 3)

    await queue.dispatch(new Work({}))
    await queue.dispatch(new Work({ fail: true }))
    // The count the sample has was asked for by the one before
    tracker.sample(1)
    await vi.waitFor(() => expect(tracker.sample(2).size).toBe(2))

    queue.start()
    await vi.waitFor(() => expect(queue.counters).toEqual({ processed: 1, retried: 1, failed: 1 }))

    expect(tracker.sample(3)).toMatchObject({
      timestamp: 3,
      processed: 1,
      retried: 1,
      failed: 1,
      running: 0,
    })
    // Counted once: the next window has none
    expect(tracker.sample(4)).toMatchObject({ processed: 0, retried: 0, failed: 0 })
    await vi.waitFor(() => expect(tracker.sample(5).size).toBe(0))
    // Keeps the last `historyLength`
    expect(tracker.history).toHaveLength(3)
    expect(tracker.history.at(-1)!.timestamp).toBe(5)
    await queue.stop()
  })

  it('keeps the last count when counting fails', async () => {
    const source = {
      driverName: 'database',
      isWorking: true,
      runningCount: 0,
      counters: { processed: 0, retried: 0, failed: 0 },
      size: vi.fn().mockResolvedValue(5),
    }
    const tracker = new QueueTracker(source)
    await vi.waitFor(() => expect(tracker.sample().size).toBe(5))

    source.size.mockRejectedValue(new Error('database gone'))
    tracker.sample()
    await new Promise(resolve => setTimeout(resolve, 5))
    expect(tracker.sample().size).toBe(5)
  })
})

describe('server metrics queue', () => {
  const logger = winston.createLogger({ transports: [], silent: true })

  it('puts the queue in the snapshot', () => {
    const game = new BaseGame(null)
    game.world = new ServerWorld()
    const queue = new Queue(null)
    const metrics = new ServerMetrics({ game, queue }, logger)

    expect(metrics.snapshot().queue).toEqual({
      driver: 'memory',
      working: false,
      latest: null,
      history: [],
    })
    metrics.sample(10)
    expect(metrics.snapshot().queue!.latest).toMatchObject({ timestamp: 10, size: 0, processed: 0 })
  })

  it('has no queue without one', () => {
    const game = new BaseGame(null)
    game.world = new ServerWorld()
    expect(new ServerMetrics({ game }, logger).snapshot().queue).toBeNull()
  })
})
