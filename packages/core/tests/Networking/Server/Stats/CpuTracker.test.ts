import { describe, expect, it, vi } from 'vitest'
import CpuTracker from '../../../../src/Networking/Server/Stats/CpuTracker'

describe('cpuTracker', () => {
  it('logs cpu stats using provided logger', () => {
    const logger = { info: vi.fn() } as any
    const tracker = new CpuTracker(logger)

    vi.spyOn(tracker as any, 'getCpuStats').mockReturnValue({
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
})
