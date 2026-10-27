import { describe, expect, it } from 'vitest'
import BandwidthTracker from '../../../../src/Networking/Server/Stats/BandwidthTracker'

describe('bandwidthTracker', () => {
  it('records usage and resets', () => {
    const tracker = new BandwidthTracker()
    tracker.recordSent('a', 10)
    tracker.recordSent('a', 5)
    tracker.recordReceived('a', 8)

    expect(tracker.getBandwidthUsage('a')).toEqual({ sent: 15, received: 8 })

    tracker.reset()
    expect(tracker.getBandwidthUsage('a')).toEqual({ sent: 0, received: 0 })
  })

  it('moves counters into the history when sampled', () => {
    const tracker = new BandwidthTracker()
    tracker.recordSent('a', 10)
    tracker.recordReceived('a', 4)

    const sample = tracker.sample('a', 1000)

    expect(sample).toEqual({ timestamp: 1000, sent: 10, received: 4 })
    expect(tracker.history).toEqual([sample])
    expect(tracker.getBandwidthUsage('a')).toEqual({ sent: 0, received: 0 })
  })

  it('caps the history length', () => {
    const tracker = new BandwidthTracker(3)

    for (let i = 0; i < 5; i++) {
      tracker.recordSent('a', i)
      tracker.sample('a', i)
    }

    expect(tracker.history.map(s => s.sent)).toEqual([2, 3, 4])
  })

  it('totals the samples within a time window', () => {
    const tracker = new BandwidthTracker()

    tracker.recordSent('a', 1)
    tracker.sample('a', 1000)
    tracker.recordSent('a', 2)
    tracker.recordReceived('a', 5)
    tracker.sample('a', 5000)
    tracker.recordSent('a', 3)
    tracker.sample('a', 6000)

    expect(tracker.getTotalSince(2000, 6000)).toEqual({ sent: 5, received: 5 })
  })
})
