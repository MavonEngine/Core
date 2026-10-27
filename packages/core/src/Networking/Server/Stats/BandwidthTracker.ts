export interface BandwidthSample {
  timestamp: number
  /** Bytes sent since the previous sample */
  sent: number
  /** Bytes received since the previous sample */
  received: number
}

export default class BandwidthTracker {
  private sent = new Map<string, number>()
  private received = new Map<string, number>()

  /**
   * Rolling history of samples, oldest first.
   * Each sample holds the bytes counted between two calls to sample().
   */
  readonly history: BandwidthSample[] = []

  constructor(private historyLength = 60) { }

  recordSent(id: string, bytes: number) {
    this.sent.set(id, (this.sent.get(id) || 0) + bytes)
  }

  recordReceived(id: string, bytes: number) {
    this.received.set(id, (this.received.get(id) || 0) + bytes)
  }

  getBandwidthUsage(id: string) {
    return {
      sent: this.sent.get(id) || 0,
      received: this.received.get(id) || 0,
    }
  }

  /**
   * Push the counters for `id` into the history and reset all counters.
   */
  sample(id: string, now = Date.now()): BandwidthSample {
    const sample = { timestamp: now, ...this.getBandwidthUsage(id) }

    this.history.push(sample)
    if (this.history.length > this.historyLength)
      this.history.splice(0, this.history.length - this.historyLength)

    this.reset()

    return sample
  }

  /**
   * Total bytes over the samples taken within the last `duration` ms.
   */
  getTotalSince(duration: number, now = Date.now()) {
    const fromTime = now - duration

    return this.history
      .filter(sample => sample.timestamp > fromTime)
      .reduce((acc, sample) => ({
        sent: acc.sent + sample.sent,
        received: acc.received + sample.received,
      }), { sent: 0, received: 0 })
  }

  reset() {
    this.sent.clear()
    this.received.clear()
  }
}
