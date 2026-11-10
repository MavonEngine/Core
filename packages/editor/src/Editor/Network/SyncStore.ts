import type { SyncSnapshot } from '@mavonengine/core/Networking/Debug/sync'
import { fetchSync } from './serverApi'

export interface SyncState {
  /** The server's state sync, undefined until the first answer or after a failed one */
  sync?: SyncSnapshot
  error?: string
}

/**
 * The server's state sync, asked for a few times a second while something listens: the sync overlay or the Network panel.
 */
export default class SyncStore {
  private state: SyncState = {}
  private listeners = new Set<() => void>()
  private timer?: ReturnType<typeof setInterval>
  private loading = false

  constructor(private intervalMs = 250, private load: () => Promise<SyncSnapshot> = fetchSync) { }

  /** Stable until the next answer, for `useSyncExternalStore` */
  get = (): SyncState => this.state

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener)
    if (!this.timer) {
      this.timer = setInterval(() => void this.refresh(), this.intervalMs)
      void this.refresh()
    }

    return () => {
      this.listeners.delete(listener)
      if (!this.listeners.size && this.timer) {
        clearInterval(this.timer)
        this.timer = undefined
      }
    }
  }

  async refresh() {
    if (this.loading)
      return
    this.loading = true

    try {
      this.state = { sync: await this.load() }
    }
    catch (err) {
      // Keep answering with the same error object, so listeners don't re-render on every failed poll
      const error = (err as Error).message
      if (this.state.error === error && !this.state.sync)
        return
      this.state = { error }
    }
    finally {
      this.loading = false
    }

    this.listeners.forEach(listener => listener())
  }
}
