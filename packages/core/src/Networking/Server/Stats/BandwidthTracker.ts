export default class BandwidthTracker {
  private sent = new Map<string, number>()
  private received = new Map<string, number>()

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

  reset() {
    this.sent.clear()
    this.received.clear()
  }
}
