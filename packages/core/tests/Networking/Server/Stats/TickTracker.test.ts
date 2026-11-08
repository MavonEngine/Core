import { describe, expect, it } from 'vitest'
import TickTracker from '../../../../src/Networking/Server/Stats/TickTracker'

describe('tickTracker', () => {
  it('summarises the ticks recorded since the last sample', () => {
    const tracker = new TickTracker(60, 0)

    tracker.record(2, 1)
    tracker.record(4, 3)
    tracker.record(6, 0)

    const sample = tracker.sample(500)

    expect(sample).toEqual({
      timestamp: 500,
      ticks: 3,
      ticksPerSecond: 6,
      avgMs: 4,
      maxMs: 6,
      commandsPerSecond: 8,
      maxCommandsPerTick: 3,
    })
    expect(tracker.latest).toBe(sample)
  })

  it('resets counters after sampling', () => {
    const tracker = new TickTracker(60, 0)

    tracker.record(10, 5)
    tracker.sample(1000)

    expect(tracker.sample(2000)).toMatchObject({ ticks: 0, avgMs: 0, maxMs: 0, commandsPerSecond: 0 })
  })

  it('caps the history length', () => {
    const tracker = new TickTracker(2, 0)

    tracker.sample(1000)
    tracker.sample(2000)
    tracker.sample(3000)

    expect(tracker.history.map(s => s.timestamp)).toEqual([2000, 3000])
  })
})
