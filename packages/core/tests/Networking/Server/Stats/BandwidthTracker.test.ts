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
})
