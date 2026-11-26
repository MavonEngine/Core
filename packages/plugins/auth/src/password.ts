import type { BinaryLike, ScryptOptions } from 'node:crypto'
import { Buffer } from 'node:buffer'
import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto'

/**
 * Password hashes with scrypt, which is built into Node: nothing native to install.
 * Stored as `scrypt$<N>$<r>$<p>$<salt>$<key>`, salt and key in base64, so the cost can be raised later
 * and old hashes still check.
 */

const COST = { N: 16384, r: 8, p: 1 }
const KEY_LENGTH = 64
const SALT_LENGTH = 16
/** N 16384 with r 8 needs 16 MiB: room for a raised N without hitting Node's 32 MiB default */
const MAX_MEMORY = 128 * 1024 * 1024

function derive(password: BinaryLike, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, KEY_LENGTH, { ...options, maxmem: MAX_MEMORY }, (err, key) => err
      ? reject(err)
      : resolve(key))
  })
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH)
  const key = await derive(password, salt, COST)
  return `scrypt$${COST.N}$${COST.r}$${COST.p}$${salt.toString('base64')}$${key.toString('base64')}`
}

/** Whether `password` is the one `stored` was made from. False for a hash it can't read */
export async function verifyPassword(password: string, stored: string): Promise<boolean> {
  const parts = stored.split('$')
  if (parts.length !== 6 || parts[0] !== 'scrypt')
    return false

  const [N, r, p] = parts.slice(1, 4).map(Number)
  if (![N, r, p].every(Number.isSafeInteger))
    return false

  const salt = Buffer.from(parts[4], 'base64')
  const expected = Buffer.from(parts[5], 'base64')
  if (expected.length !== KEY_LENGTH)
    return false

  try {
    return timingSafeEqual(await derive(password, salt, { N, r, p }), expected)
  }
  catch {
    return false
  }
}

/** A hash of no one's password: checked against when the username doesn't exist, so that takes as long as a wrong password */
let decoy: Promise<string> | undefined
export function decoyHash(): Promise<string> {
  decoy ??= hashPassword(randomBytes(16).toString('hex'))
  return decoy
}
