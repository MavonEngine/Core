import type winston from 'winston'

export interface LatencySimulatorOptions {
  /** Minimum latency to simulate */
  fixedLatency?: number

  /** How much ms jitter should we include */
  jitter?: number

  /**
   * How much percent packet loss to simulate between 0 - 1
   * 1 = 100%
   * 0 = 0%
   */
  packetLoss?: number
}

export default class LatencySimulator {
  private options: Required<LatencySimulatorOptions>

  constructor(options: LatencySimulatorOptions, logger: winston.Logger) {
    this.options = {
      fixedLatency: 0,
      jitter: 0,
      packetLoss: 0,
      ...options, // Spread incoming over the defaults
    }

    logger.warn(`RUNNING WITH LATENCY SIMULATION: latency ${this.options.fixedLatency}ms, jitter: ${this.options.jitter}ms, packet loss: ${this.options.packetLoss}%`)
  }

  /**
   * Calculate our latency items and then
   * run the callback as appropriate
   */
  public handle(cb: () => void) {
    if (Math.random() < this.options.packetLoss) {
      // Drop the packet completely
      return
    }

    const latency = this.options.fixedLatency + (Math.random() - 0.5) * this.options.jitter

    setTimeout(() => {
      cb()
    }, latency)
  }
}
