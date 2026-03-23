type LogLevel = 'error' | 'warn' | 'info' | 'debug'

const levels: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
}

const styles: Record<LogLevel, string> = {
  error: 'background: #f44336; color: white; padding: 2px 6px; border-radius: 3px;',
  warn: 'background: #ff9800; color: white; padding: 2px 6px; border-radius: 3px;',
  info: 'background: #2196F3; color: white; padding: 2px 6px; border-radius: 3px;',
  debug: 'background: #9E9E9E; color: white; padding: 2px 6px; border-radius: 3px;',
}

const labelStyle = 'color: #888; font-weight: normal;'

export default class Logger {
  private level: number

  constructor(level: LogLevel = 'error') {
    this.level = levels[level]
  }

  error(message: string, ...args: unknown[]) {
    if (this.level >= levels.error)
      console.error(`%c ERROR %c ${message}`, styles.error, labelStyle, ...args)
  }

  warn(message: string, ...args: unknown[]) {
    if (this.level >= levels.warn)
      console.warn(`%c WARN %c ${message}`, styles.warn, labelStyle, ...args)
  }

  info(message: string, ...args: unknown[]) {
    if (this.level >= levels.info)
      // eslint-disable-next-line no-console
      console.info(`%c INFO %c ${message}`, styles.info, labelStyle, ...args)
  }

  debug(message: string, ...args: unknown[]) {
    if (this.level >= levels.debug)
      // eslint-disable-next-line no-console
      console.debug(`%c DEBUG %c ${message}`, styles.debug, labelStyle, ...args)
  }

  emerg(message: string, ...args: unknown[]) {
    console.error(`%c EMERG %c ${message}`, styles.error, labelStyle, ...args)
  }
}
