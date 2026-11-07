import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'

const MAGIC = '$apr1$'
const ITOA64 = './0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz'

function md5(...parts: Buffer[]): Buffer {
  const hash = createHash('md5')
  for (const part of parts)
    hash.update(part)
  return hash.digest()
}

function to64(value: number, length: number): string {
  let out = ''
  for (let i = 0; i < length; i++) {
    out += ITOA64[value & 0x3F]
    value >>= 6
  }
  return out
}

/**
 * Apache's MD5 password hash (`$apr1$<salt>$<hash>`), what `htpasswd` writes by default.
 * Returns the full hash string for `password` with `salt` (at most 8 characters are used).
 */
export function apr1(password: string, salt: string): string {
  const pw = Buffer.from(password, 'utf8')
  const s = Buffer.from(salt.slice(0, 8), 'utf8')
  const magic = Buffer.from(MAGIC, 'utf8')

  let final = md5(pw, s, pw)

  const parts: Buffer[] = [pw, magic, s]
  for (let left = pw.length; left > 0; left -= 16)
    parts.push(final.subarray(0, Math.min(left, 16)))

  // Odd quirk of the original algorithm: a NUL byte for set bits, the first password byte for unset ones
  for (let i = pw.length; i > 0; i >>= 1)
    parts.push(i & 1 ? Buffer.from([0]) : pw.subarray(0, 1))

  final = md5(...parts)

  // Deliberately slow
  for (let i = 0; i < 1000; i++) {
    const round: Buffer[] = [i & 1 ? pw : final]
    if (i % 3)
      round.push(s)
    if (i % 7)
      round.push(pw)
    round.push(i & 1 ? final : pw)
    final = md5(...round)
  }

  const f = final
  const encoded = to64((f[0] << 16) | (f[6] << 8) | f[12], 4)
    + to64((f[1] << 16) | (f[7] << 8) | f[13], 4)
    + to64((f[2] << 16) | (f[8] << 8) | f[14], 4)
    + to64((f[3] << 16) | (f[9] << 8) | f[15], 4)
    + to64((f[4] << 16) | (f[10] << 8) | f[5], 4)
    + to64(f[11], 2)

  return `${MAGIC}${salt.slice(0, 8)}$${encoded}`
}
