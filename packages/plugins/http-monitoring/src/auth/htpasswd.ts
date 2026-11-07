import { Buffer } from 'node:buffer'
import { createHash, timingSafeEqual } from 'node:crypto'
import bcrypt from 'bcryptjs'
import { apr1 } from './apr1'

/** Checks a password against one stored hash */
export type PasswordVerifier = (password: string) => Promise<boolean>

export interface HtpasswdUsers {
  users: Map<string, PasswordVerifier>
  /** Lines that were skipped, e.g. for a hash format that isn't supported */
  warnings: string[]
}

const BCRYPT_RE = /^\$2[aby]\$\d{2}\$/
const APR1_RE = /^\$apr1\$([^$]{1,8})\$/
const NEWLINE_RE = /\r?\n/
const BCRYPT_2Y_RE = /^\$2y\$/

export function safeEqual(a: string, b: string): boolean {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)
  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}

/**
 * A verifier for one htpasswd hash, or undefined for a format that isn't supported.
 * Supported: bcrypt (`htpasswd -B`, recommended), Apache MD5 (`$apr1$`, the htpasswd default) and SHA-1 (`{SHA}`).
 */
export function verifierFor(hash: string): PasswordVerifier | undefined {
  if (BCRYPT_RE.test(hash)) {
    // $2y$ is Apache's name for $2b$, which bcryptjs knows
    const normalized = hash.replace(BCRYPT_2Y_RE, '$2b$')
    return password => bcrypt.compare(password, normalized)
  }

  const apr1Salt = APR1_RE.exec(hash)?.[1]
  if (apr1Salt !== undefined)
    return async password => safeEqual(apr1(password, apr1Salt), hash)

  if (hash.startsWith('{SHA}')) {
    return async password => safeEqual(`{SHA}${createHash('sha1').update(password, 'utf8').digest('base64')}`, hash)
  }

  return undefined
}

/**
 * Parse an htpasswd file: one `user:hash` per line, `#` comments and blank lines ignored.
 */
export function parseHtpasswd(content: string, source = 'htpasswd'): HtpasswdUsers {
  const users = new Map<string, PasswordVerifier>()
  const warnings: string[] = []

  content.split(NEWLINE_RE).forEach((raw, index) => {
    const line = raw.trim()
    if (!line || line.startsWith('#'))
      return

    const colon = line.indexOf(':')
    if (colon <= 0) {
      warnings.push(`${source}:${index + 1}: expected user:hash`)
      return
    }

    const user = line.slice(0, colon)
    const hash = line.slice(colon + 1)
    const verify = verifierFor(hash)
    if (!verify) {
      warnings.push(`${source}:${index + 1}: user "${user}" has a hash format that isn't supported (use bcrypt: htpasswd -B)`)
      return
    }

    users.set(user, verify)
  })

  return { users, warnings }
}
