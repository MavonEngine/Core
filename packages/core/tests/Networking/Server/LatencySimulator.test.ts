import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import LatencySimulator from '../../../src/Networking/Server/LatencySimulator'

function makeLogger() {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() } as any
}

describe('latencySimulator', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  it('logs configuration on construction', () => {
    const logger = makeLogger()
    void new LatencySimulator({ fixedLatency: 100, jitter: 20, packetLoss: 0.1 }, logger)
    expect(logger.warn).toHaveBeenCalledWith(
      'RUNNING WITH LATENCY SIMULATION: latency 100ms, jitter: 20ms, packet loss: 0.1%',
    )
  })

  it('fills missing options with zero defaults', () => {
    const logger = makeLogger()
    void new LatencySimulator({}, logger)
    expect(logger.warn).toHaveBeenCalledWith(
      'RUNNING WITH LATENCY SIMULATION: latency 0ms, jitter: 0ms, packet loss: 0%',
    )
  })

  it('invokes the callback synchronously when latency is 0 and no jitter', () => {
    const sim = new LatencySimulator({}, makeLogger())
    const cb = vi.fn()

    sim.handle(cb)
    expect(cb).not.toHaveBeenCalled()

    vi.advanceTimersByTime(0)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('delays the callback by fixedLatency ms', () => {
    const sim = new LatencySimulator({ fixedLatency: 150 }, makeLogger())
    const cb = vi.fn()

    sim.handle(cb)

    vi.advanceTimersByTime(149)
    expect(cb).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('applies jitter within +/- jitter/2 of fixedLatency', () => {
    const sim = new LatencySimulator({ fixedLatency: 100, jitter: 40 }, makeLogger())
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const randomSpy = vi.spyOn(Math, 'random')

    // handle() calls Math.random() twice: once for packet-loss check, once for jitter.
    // First sample: 0.5 (no drop, packetLoss = 0 anyway), jitter draw: 0 → 100 + (0 - 0.5) * 40 = 80
    randomSpy.mockReturnValueOnce(0.5).mockReturnValueOnce(0)
    sim.handle(vi.fn())
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 80)

    // jitter draw: 1 → 100 + (1 - 0.5) * 40 = 120
    randomSpy.mockReturnValueOnce(0.5).mockReturnValueOnce(1)
    sim.handle(vi.fn())
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 120)

    // jitter draw: 0.5 → 100 (no jitter)
    randomSpy.mockReturnValueOnce(0.5).mockReturnValueOnce(0.5)
    sim.handle(vi.fn())
    expect(setTimeoutSpy).toHaveBeenLastCalledWith(expect.any(Function), 100)
  })

  it('drops the packet when packetLoss is 1', () => {
    const sim = new LatencySimulator({ fixedLatency: 100, packetLoss: 1 }, makeLogger())
    const cb = vi.fn()

    sim.handle(cb)

    vi.runAllTimers()
    expect(cb).not.toHaveBeenCalled()
  })

  it('never drops the packet when packetLoss is 0', () => {
    const sim = new LatencySimulator({ fixedLatency: 50, packetLoss: 0 }, makeLogger())
    const cb = vi.fn()

    // Force Math.random() near 0 — would drop if packetLoss > 0
    vi.spyOn(Math, 'random').mockReturnValue(0)

    sim.handle(cb)
    vi.runAllTimers()
    expect(cb).toHaveBeenCalledTimes(1)
  })

  it('drops only when Math.random() falls below packetLoss threshold', () => {
    const sim = new LatencySimulator({ fixedLatency: 0, packetLoss: 0.3 }, makeLogger())

    const dropped = vi.fn()
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.1) // below 0.3 → dropped
    sim.handle(dropped)
    vi.runAllTimers()
    expect(dropped).not.toHaveBeenCalled()

    const delivered = vi.fn()
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.5).mockReturnValueOnce(0.5)
    sim.handle(delivered)
    vi.runAllTimers()
    expect(delivered).toHaveBeenCalledTimes(1)
  })

  it('handles many concurrent callbacks independently', () => {
    const sim = new LatencySimulator({ fixedLatency: 100 }, makeLogger())
    const cbs = Array.from({ length: 5 }, () => vi.fn())

    cbs.forEach(cb => sim.handle(cb))

    vi.advanceTimersByTime(100)
    cbs.forEach(cb => expect(cb).toHaveBeenCalledTimes(1))
  })
})
