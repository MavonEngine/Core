import { describe, expect, it } from 'vitest'
import { formatBytes, formatDuration, formatMs, formatRate } from '../src/dashboard/format'

describe('format', () => {
  it('formats bytes', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(5 * 1024 ** 3)).toBe('5.0 GiB')
    expect(formatBytes(Number.NaN)).toBe('0 B')
    expect(formatRate(2048)).toBe('2.0 KiB/s')
  })

  it('formats durations', () => {
    expect(formatDuration(5)).toBe('5s')
    expect(formatDuration(65)).toBe('1m 5s')
    expect(formatDuration(3725)).toBe('1h 2m 5s')
    expect(formatDuration(90061)).toBe('1d 1h 1m')
  })

  it('formats ms', () => {
    expect(formatMs(3.14159)).toBe('3.14 ms')
    expect(formatMs(33.333)).toBe('33.3 ms')
  })
})
