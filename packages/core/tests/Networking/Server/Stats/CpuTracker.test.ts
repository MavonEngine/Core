import { describe, expect, it, vi } from 'vitest'
import CpuTracker from '../../../../src/Networking/Server/Stats/CpuTracker'

describe('cpuTracker', () => {
  it('logs cpu stats using provided logger', () => {
    const logger = { info: vi.fn() } as any
    const tracker = new CpuTracker(logger)

    vi.spyOn(tracker, 'sample').mockReturnValue({
      timestamp: 0,
      userCPU: 1,
      systemCPU: 2,
      totalUsedCPU: 3,
      cpuPercentage: 50,
      avg1s: 10,
      avg10s: 20,
      avg60s: 30,
    })

    tracker.log()
    expect(logger.info).toHaveBeenCalledWith(
      'CPU Usage - User: 1.00 ms, System: 2.00 ms, Total 1s: 10%, Total 10s: 20%, Total 1m: 30%',
    )
  })

  it('logs the latest sample instead of taking a new one', () => {
    const logger = { info: vi.fn() } as any
    const tracker = new CpuTracker(logger)

    const latest = tracker.sample()
    const sample = vi.spyOn(tracker, 'sample')

    tracker.log()

    expect(sample).not.toHaveBeenCalled()
    expect(tracker.latest).toBe(latest)
  })

  it('records each sample in the history', () => {
    const tracker = new CpuTracker({ info: vi.fn() } as any)

    tracker.sample()
    tracker.sample()

    expect(tracker.history).toHaveLength(2)
    expect(Number.isFinite(tracker.history[1].cpuPercentage)).toBe(true)
  })
})
