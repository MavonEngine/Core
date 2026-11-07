import { describe, expect, it } from 'vitest'
import { apr1 } from '../src/auth/apr1'
import { parseHtpasswd, verifierFor } from '../src/auth/htpasswd'

// Generated with Apache's htpasswd: -B (bcrypt), -m (MD5) and -s (SHA-1)
const BCRYPT = '$2y$05$K8Fs4e1114O.zAfw1Ht/9ueTdlQ/OO5tXHlvF7J1IOeUtfixsQLbG' // secret
const APR1 = '$apr1$/JmjNbl4$7OwIOno5XIdi.TZFKCN801' // hunter2
const SHA = '{SHA}3jlYfsnWMi7F2C1+fdQaJ5Rr39M=' // pa55

describe('apr1', () => {
  it('matches Apache\'s htpasswd -m', () => {
    expect(apr1('hunter2', '/JmjNbl4')).toBe(APR1)
  })

  it('handles passwords longer than 16 bytes and non-ASCII ones', () => {
    // openssl passwd -apr1 -salt abcdefgh 'a password longer than sixteen bytes'
    expect(apr1('a password longer than sixteen bytes', 'abcdefgh')).toBe('$apr1$abcdefgh$KxnTlry9zkkkUhSc6GrVg/')
    // openssl passwd -apr1 -salt 12345678 'pässwörd'
    expect(apr1('pässwörd', '12345678')).toBe('$apr1$12345678$0NJU6izOW5MGH4BL2C/sK/')
  })
})

describe('verifierFor', () => {
  it.each([
    ['bcrypt', BCRYPT, 'secret'],
    ['apr1', APR1, 'hunter2'],
    ['sha', SHA, 'pa55'],
  ])('verifies %s hashes', async (_name, hash, password) => {
    const verify = verifierFor(hash)!

    expect(await verify(password)).toBe(true)
    expect(await verify(`${password}x`)).toBe(false)
    expect(await verify('')).toBe(false)
  })

  it('does not support crypt(3) or plain text', () => {
    expect(verifierFor('rqXexS6ZhobKA')).toBeUndefined()
    expect(verifierFor('plaintext')).toBeUndefined()
  })
})

describe('parseHtpasswd', () => {
  it('reads users, ignoring comments and blank lines', async () => {
    const { users, warnings } = parseHtpasswd(`# admins\nalice:${BCRYPT}\n\nbob:${APR1}\r\ncarol:${SHA}\n`)

    expect([...users.keys()]).toEqual(['alice', 'bob', 'carol'])
    expect(await users.get('bob')!('hunter2')).toBe(true)
    expect(warnings).toEqual([])
  })

  it('warns about lines it can\'t use', () => {
    const { users, warnings } = parseHtpasswd('dave:rqXexS6ZhobKA\nnocolon\n:nouser', '/etc/monitoring.htpasswd')

    expect(users.size).toBe(0)
    expect(warnings).toEqual([
      '/etc/monitoring.htpasswd:1: user "dave" has a hash format that isn\'t supported (use bcrypt: htpasswd -B)',
      '/etc/monitoring.htpasswd:2: expected user:hash',
      '/etc/monitoring.htpasswd:3: expected user:hash',
    ])
  })
})
