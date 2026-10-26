export interface TickSample {
  timestamp: number
  /** Number of ticks run since the previous sample */
  ticks: number
  /** Ticks per second over the sample window */
  ticksPerSecond: number
  /** Average time spent inside a tick in ms */
  avgMs: number
  /** Slowest tick in ms */
  maxMs: number
  /** Client commands processed per second */
  commandsPerSecond: number
  /** Most commands processed in a single tick */
  maxCommandsPerTick: number
}

export default class TickTracker {
  private ticks = 0
  private totalMs = 0
  private maxMs = 0
  private commands = 0
  private maxCommandsPerTick = 0
  private lastSampleTime: number

  /**
   * Rolling history of samples, oldest first.
   */
  readonly history: TickSample[] = []

  constructor(private historyLength = 60, now = Date.now()) {
    this.lastSampleTime = now
  }

  record(durationMs: number, commandsProcessed = 0) {
    this.ticks++
    this.totalMs += durationMs
    this.maxMs = Math.max(this.maxMs, durationMs)
    this.commands += commandsProcessed
    this.maxCommandsPerTick = Math.max(this.maxCommandsPerTick, commandsProcessed)
  }

  /**
   * Summarise the ticks recorded since the previous sample, add it to the history and reset the counters.
   */
  sample(now = Date.now()): TickSample {
    const elapsedSeconds = Math.max(now - this.lastSampleTime, 1) / 1000

    const sample: TickSample = {
      timestamp: now,
      ticks: this.ticks,
      ticksPerSecond: round(this.ticks / elapsedSeconds),
      avgMs: this.ticks > 0 ? round(this.totalMs / this.ticks) : 0,
      maxMs: round(this.maxMs),
      commandsPerSecond: round(this.commands / elapsedSeconds),
      maxCommandsPerTick: this.maxCommandsPerTick,
    }

    this.history.push(sample)
    if (this.history.length > this.historyLength)
      this.history.splice(0, this.history.length - this.historyLength)

    this.ticks = 0
    this.totalMs = 0
    this.maxMs = 0
    this.commands = 0
    this.maxCommandsPerTick = 0
    this.lastSampleTime = now

    return sample
  }

  get latest(): TickSample | undefined {
    return this.history.at(-1)
  }
}

function round(value: number) {
  return Math.round(value * 100) / 100
}
