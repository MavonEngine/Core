/** Most counters kept at once, so a flood of keys (addresses, usernames) can't fill the memory */
const MAX_COUNTERS = 10_000

/**
 * Counts what happened per key within a window, e.g. failed logins per address and username, and says when a key
 * reached its limit. In memory: a restart forgets the counts.
 */
export default class RateLimit {
  private counters = new Map<string, { count: number, resetAt: number }>()

  constructor(private readonly limit: number, private readonly windowMs: number, private readonly now: () => number = Date.now) {}

  /** Seconds to wait when `key` reached the limit, undefined while it may go on */
  blocked(key: string): number | undefined {
    const now = this.now()
    const entry = this.counters.get(key)
    if (!entry || entry.resetAt <= now || entry.count < this.limit)
      return undefined
    return Math.ceil((entry.resetAt - now) / 1000)
  }

  hit(key: string) {
    const now = this.now()
    const entry = this.counters.get(key)
    if (entry && entry.resetAt > now) {
      entry.count++
      return
    }

    if (this.counters.size >= MAX_COUNTERS) {
      for (const [k, e] of this.counters) {
        if (e.resetAt <= now)
          this.counters.delete(k)
      }
      // Still full: drop the oldest, Maps keep insertion order
      if (this.counters.size >= MAX_COUNTERS)
        this.counters.delete(this.counters.keys().next().value!)
    }
    this.counters.set(key, { count: 1, resetAt: now + this.windowMs })
  }

  reset(key: string) {
    this.counters.delete(key)
  }

  clear() {
    this.counters.clear()
  }
}
