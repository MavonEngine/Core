import { describe, expect, it } from 'vitest'
import { accountLabel, appendFeed, backoff, formatBytes, formatDuration, formatMs, formatRate, queueTitle, queueTotals, queueWindow, showAccounts, showNames, sortedPlayers, statusClass, trimMessage } from '../ui/format.js'

describe('format', () => {
  it('formats like the CLI dashboard', () => {
    expect(formatBytes(0)).toBe('0 B')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.5 KiB')
    expect(formatBytes(0.5)).toBe('0.5 B')
    expect(formatRate(2 * 1024 * 1024)).toBe('2.0 MiB/s')
    expect(formatDuration(59)).toBe('59s')
    expect(formatDuration(3725)).toBe('1h 2m 5s')
    expect(formatDuration(90061)).toBe('1d 1h 1m')
    expect(formatMs(3.14159)).toBe('3.14 ms')
    expect(formatMs(33.333)).toBe('33.3 ms')
  })

  it('colors HTTP statuses', () => {
    expect([null, 503, 404, 301, 200].map(statusClass)).toEqual([
      'danger',
      'danger',
      'warning',
      'info',
      'success',
    ])
  })

  it('sorts players by id and only shows names once a game sets them', () => {
    const players = [
      { id: 'b', displayName: 'b' },
      { id: 'a', displayName: 'a' },
    ]

    expect(sortedPlayers(players).map(p => p.id)).toEqual(['a', 'b'])
    expect(showNames(players)).toBe(false)
    expect(showNames([
      ...players,
      { id: 'c', displayName: 'Carol' },
    ])).toBe(true)
  })

  it('keeps the newest feed entries', () => {
    expect(appendFeed([1, 2], [3, 4], 3)).toEqual([2, 3, 4])
  })

  it('trims blank lines around multi-line messages', () => {
    expect(trimMessage('\n\n  banner\n  line 2\n\n')).toBe('  banner\n  line 2')
    expect(trimMessage('')).toBe('')
  })

  it('backs off like the CLI', () => {
    expect([0, 1, 2, 3, 4, 5].map(f => backoff(1000, f))).toEqual([1000, 2000, 4000, 8000, 10000, 10000])
  })

  it('labels accounts like the CLI, guests marked', () => {
    expect(accountLabel(null)).toBe('—')
    expect(accountLabel(undefined)).toBe('—')
    expect(accountLabel({ id: 'a1', name: 'Ada' })).toBe('Ada')
    expect(accountLabel({ id: 'g1', name: 'Guest-12', guest: true })).toBe('Guest-12 (guest)')
    expect(accountLabel({ id: 'a2' })).toBe('a2')
    // The column only shows when someone has an account, as on a server without auth, or older than accounts
    expect(showAccounts([
      { account: null },
      {},
    ])).toBe(false)
    expect(showAccounts([
      { account: null },
      {
        account: { id: 'a1' },
      },
    ])).toBe(true)
  })

  it('titles and totals the queue like the CLI', () => {
    const sample = (timestamp: number, processed: number, retried: number, failed: number) => ({
      timestamp,
      size: 0,
      running: 0,
      processed,
      retried,
      failed,
    })
    const queue = {
      driver: 'database',
      working: true,
      latest: null,
      history: [
        sample(0, 2, 0, 0),
        sample(30_000, 3, 1, 1),
        sample(90_000, 1, 0, 2),
      ],
    }

    expect(queueTitle(queue)).toBe('Queue (database)')
    expect(queueTitle({ ...queue, driver: 'memory', working: false })).toBe('Queue (memory, not worked here)')
    expect(queueTotals(queue)).toEqual({ processed: 6, retried: 1, failed: 3 })
    expect(queueWindow(queue)).toBe('2m')
    expect(queueWindow({
      ...queue,
      history: queue.history.slice(0, 2),
    })).toBe('30s')
    expect(queueWindow({ ...queue, history: [] })).toBe('0s')
  })
})
