import { describe, expect, it } from 'vitest'
import { simulatedSource } from '../src/dashboard/simulator'
import { normalizeLogs, normalizeSnapshot } from '../src/dashboard/snapshot'

describe('normalizeSnapshot', () => {
  it('keeps a complete snapshot as is', async () => {
    const snapshot = await simulatedSource().fetch()

    expect(normalizeSnapshot(snapshot)).toEqual(snapshot)
  })

  it('fills in everything for an empty response', () => {
    const snapshot = normalizeSnapshot({})

    expect(snapshot.players).toEqual([])
    expect(snapshot.cpu.history).toEqual([])
    expect(snapshot.tick.latest).toBeNull()
    expect(snapshot.physics).toBeNull()
    expect(snapshot.latencySimulation).toBeNull()
    expect(snapshot.sampleIntervalMs).toBe(1000)
    expect(snapshot.engineVersion).toBe('unknown')
  })

  it('survives garbage', () => {
    expect(() => normalizeSnapshot(null)).not.toThrow()
    expect(() => normalizeSnapshot('nope')).not.toThrow()
    expect(normalizeSnapshot({ players: [null, 3, { id: 'a' }] }).players).toEqual([
      { id: 'a', position: { x: 0, y: 0, z: 0 }, lastProcessedSequenceId: 0, trackedEntities: 0 },
    ])
  })

  it('replaces non-finite numbers', () => {
    const snapshot = normalizeSnapshot({ cpu: { current: Number.NaN, avg1s: 'x' }, sampleIntervalMs: 0 })

    expect(snapshot.cpu.current).toBe(0)
    expect(snapshot.cpu.avg1s).toBe(0)
    expect(snapshot.sampleIntervalMs).toBe(1000)
  })

  it('ignores fields it does not know', () => {
    const snapshot = normalizeSnapshot({ uptime: 5, somethingNew: { a: 1 } })

    expect(snapshot.uptime).toBe(5)
    expect(snapshot).not.toHaveProperty('somethingNew')
  })
})

describe('normalizeLogs', () => {
  it('fills in missing fields and drops garbage entries', () => {
    expect(normalizeLogs({ entries: [{ id: 4, message: 'hi' }, null, 'x'] })).toEqual({
      entries: [{ id: 4, timestamp: 0, level: 'info', message: 'hi' }],
      latestId: 4,
    })
  })

  it('handles an empty response', () => {
    expect(normalizeLogs(undefined)).toEqual({ entries: [], latestId: 0 })
  })
})
