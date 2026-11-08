import { describe, expect, it } from 'vitest'
import winston from 'winston'
import LogBuffer from '../../../../src/Networking/Server/Stats/LogBuffer'

describe('logBuffer', () => {
  it('records entries logged through winston', () => {
    const buffer = new LogBuffer()
    const logger = winston.createLogger({ level: 'info', transports: [buffer.transport] })

    logger.info('hello')
    logger.warn('careful')
    logger.debug('hidden by the logger level')

    expect(buffer.since().entries.map(e => [e.id, e.level, e.message])).toEqual([
      [1, 'info', 'hello'],
      [2, 'warn', 'careful'],
    ])
  })

  it('strips ANSI colors added by formats', () => {
    const buffer = new LogBuffer()
    const logger = winston.createLogger({
      format: winston.format.colorize({ all: true }),
      transports: [buffer.transport],
    })

    logger.error('boom')

    expect(buffer.since().entries[0]).toMatchObject({ level: 'error', message: 'boom' })
  })

  it('stringifies non-string messages', () => {
    const buffer = new LogBuffer()

    buffer.push('info', { a: 1 })

    expect(buffer.since().entries[0].message).toBe('{"a":1}')
  })

  it('returns only entries after the given id', () => {
    const buffer = new LogBuffer()
    buffer.push('info', 'one')
    buffer.push('info', 'two')
    buffer.push('info', 'three')

    expect(buffer.since(2)).toEqual({
      entries: [expect.objectContaining({ id: 3, message: 'three' })],
      latestId: 3,
    })
    expect(buffer.since(3)).toEqual({ entries: [], latestId: 3 })
  })

  it('drops the oldest entries past capacity but keeps counting ids', () => {
    const buffer = new LogBuffer(2)
    buffer.push('info', 'one')
    buffer.push('info', 'two')
    buffer.push('info', 'three')

    const { entries, latestId } = buffer.since()

    expect(entries.map(e => e.id)).toEqual([2, 3])
    expect(latestId).toBe(3)
  })
})
