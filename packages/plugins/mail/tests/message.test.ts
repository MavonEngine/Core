import { describe, expect, it } from 'vitest'
import { formatAddress, MailError, parseAddress, toMessage } from '../src/message'

describe('parseAddress', () => {
  it('takes a bare address, one with a name, or an object', () => {
    expect(parseAddress('player@example.com')).toEqual({ address: 'player@example.com' })
    expect(parseAddress(' Player One <player@example.com> ')).toEqual({ address: 'player@example.com', name: 'Player One' })
    expect(parseAddress('"One, Player" <player@example.com>')).toEqual({ address: 'player@example.com', name: 'One, Player' })
    expect(parseAddress({ address: 'player@example.com', name: ' ' })).toEqual({ address: 'player@example.com' })
  })

  it('refuses what is no address, and names that would break the header', () => {
    for (const bad of [
      '',
      'player',
      'player@',
      '@example.com',
      'a b@example.com',
      'a@b@example.com',
      'x <nope>',
      'a@example.com, b@example.com',
    ])
      expect(() => parseAddress(bad), bad).toThrow(MailError)
    expect(() => parseAddress({ address: 'player@example.com', name: 'x\r\nBcc: victim@example.com' })).toThrow('line break')
    expect(() => parseAddress(42 as never)).toThrow(MailError)
  })

  it('formats a mailbox for a header', () => {
    expect(formatAddress({ address: 'a@example.com' })).toBe('a@example.com')
    expect(formatAddress({ address: 'a@example.com', name: 'Say "hi"' })).toBe('"Say \\"hi\\"" <a@example.com>')
  })
})

describe('toMessage', () => {
  const from = { address: 'game@example.com', name: 'Game' }

  it('brings a mail into the shape transports get, with the default sender', () => {
    expect(toMessage({
      to: 'a@example.com',
      cc: ['B <b@example.com>'],
      subject: ' Hi ',
      text: 'Hello',
      headers: { 'X-Game': 'quest' },
    }, from)).toEqual({
      from,
      to: [
        { address: 'a@example.com' },
      ],
      cc: [
        { address: 'b@example.com', name: 'B' },
      ],
      subject: 'Hi',
      text: 'Hello',
      headers: { 'X-Game': 'quest' },
    })
    expect(toMessage({
      to: 'a@example.com',
      from: 'other@example.com',
      subject: 'Hi',
      html: '<p>Hi</p>',
    }, from).from).toEqual({ address: 'other@example.com' })
    expect(toMessage({ to: 'a@example.com', subject: 'Hi', text: 'x' })).not.toHaveProperty('from')
  })

  it('refuses a mail no transport could send', () => {
    const ok = { to: 'a@example.com', subject: 'Hi', text: 'x' }
    expect(() => toMessage({ ...ok, to: [] })).toThrow('someone to send it to')
    expect(() => toMessage({ ...ok, subject: ' ' })).toThrow('needs a subject')
    expect(() => toMessage({ ...ok, subject: 'Hi\r\nBcc: victim@example.com' })).toThrow('line break')
    expect(() => toMessage({ ...ok, text: '' })).toThrow('text or html')
    expect(() => toMessage({
      ...ok,
      headers: { Bcc: 'victim@example.com' },
    })).toThrow('can\'t have a "Bcc" header')
    expect(() => toMessage({
      ...ok,
      headers: { 'X-A': 'a\nb' },
    })).toThrow('without line breaks')
    expect(() => toMessage({
      ...ok,
      headers: { 'X A': 'a' },
    })).toThrow('header')
    expect(() => toMessage(null as never)).toThrow(MailError)
  })
})
