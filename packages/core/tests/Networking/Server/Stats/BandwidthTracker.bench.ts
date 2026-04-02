import { bench, describe } from 'vitest'
import BandwidthTracker from '../../../../src/Networking/Server/Stats/BandwidthTracker'

describe('bandwidthTracker', () => {
  bench('recordSent — single id', () => {
    const tracker = new BandwidthTracker()
    tracker.recordSent('client-1', 128)
  })

  bench('recordSent — accumulation (same id, 100 calls)', () => {
    const tracker = new BandwidthTracker()
    for (let i = 0; i < 100; i++) {
      tracker.recordSent('client-1', 128)
    }
  })

  bench('recordSent — 50 unique ids', () => {
    const tracker = new BandwidthTracker()
    for (let i = 0; i < 50; i++) {
      tracker.recordSent(`client-${i}`, 128)
    }
  })

  bench('getBandwidthUsage — existing id', () => {
    const tracker = new BandwidthTracker()
    tracker.recordSent('client-1', 128)
    tracker.getBandwidthUsage('client-1')
  })

  bench('getBandwidthUsage — missing id', () => {
    const tracker = new BandwidthTracker()
    tracker.getBandwidthUsage('client-1')
  })

  bench('reset — 50 entries', () => {
    const tracker = new BandwidthTracker()
    for (let i = 0; i < 50; i++) {
      tracker.recordSent(`client-${i}`, 128)
      tracker.recordReceived(`client-${i}`, 64)
    }
    tracker.reset()
  })
})
