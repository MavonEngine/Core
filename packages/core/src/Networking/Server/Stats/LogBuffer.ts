import type winston from 'winston'
import { Writable } from 'node:stream'
import { stripVTControlCharacters } from 'node:util'
import { transports } from 'winston'

export interface LogEntry {
  /** Increases by one per entry, so clients can ask for what they haven't seen */
  id: number
  timestamp: number
  level: string
  message: string
}

export interface LogsResponse {
  entries: LogEntry[]
  /** Id of the newest entry, 0 when nothing was logged yet */
  latestId: number
}

/**
 * Keeps the most recent log entries of a winston logger in memory
 * so they can be served to the dashboard.
 */
export default class LogBuffer {
  private entries: LogEntry[] = []
  private nextId = 1

  /**
   * Winston transport that feeds this buffer. It has no level of its own,
   * so it records whatever the logger's level lets through.
   */
  readonly transport: winston.transport

  constructor(private capacity = 500) {
    this.transport = new transports.Stream({
      stream: new Writable({
        objectMode: true,
        write: (info: winston.Logform.TransformableInfo, _encoding, callback) => {
          this.push(info.level, info.message)
          callback()
        },
      }),
    })
  }

  push(level: unknown, message: unknown, now = Date.now()) {
    this.entries.push({
      id: this.nextId++,
      timestamp: now,
      // Formats like colorize() add ANSI codes, which the dashboard draws itself
      level: stripVTControlCharacters(String(level)),
      message: stripVTControlCharacters(typeof message === 'string' ? message : JSON.stringify(message) ?? String(message)),
    })

    if (this.entries.length > this.capacity)
      this.entries.splice(0, this.entries.length - this.capacity)
  }

  /**
   * Entries newer than `afterId`, oldest first.
   */
  since(afterId = 0): LogsResponse {
    return {
      entries: this.entries.filter(entry => entry.id > afterId),
      latestId: this.nextId - 1,
    }
  }
}
