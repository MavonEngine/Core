import { describe, expect, it } from 'vitest'
import { decoyHash, hashPassword, verifyPassword } from '../src/password'

describe('password', () => {
  it('checks a password against its hash, salted so equal passwords hash differently', async () => {
    const hash = await hashPassword('correct horse')

    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$[\w+/=]+\$[\w+/=]+$/)
    expect(await verifyPassword('correct horse', hash)).toBe(true)
    expect(await verifyPassword('correct horsf', hash)).toBe(false)
    expect(await hashPassword('correct horse')).not.toBe(hash)
  })

  it('says no to hashes it can\'t read instead of throwing', async () => {
    for (const bad of [
      '',
      'plain',
      'bcrypt$1$2$3$4$5',
      'scrypt$x$8$1$AAAA$AAAA',
      'scrypt$16384$8$1$AAAA$AAAA',
    ])
      expect(await verifyPassword('anything', bad)).toBe(false)
  })

  it('has a decoy no password matches', async () => {
    expect(await verifyPassword('', await decoyHash())).toBe(false)
    expect(await decoyHash()).toBe(await decoyHash())
  })
})
