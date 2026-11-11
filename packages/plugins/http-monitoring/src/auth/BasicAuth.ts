import type { NextFunction, Request, Response } from 'express'
import type { PasswordVerifier } from './htpasswd'
import { Buffer } from 'node:buffer'
import { createHash } from 'node:crypto'
import { readFileSync, statSync } from 'node:fs'
import { parseHtpasswd, safeEqual } from './htpasswd'

export interface Logger {
  info(message: string): void
  warn(message: string): void
}

/** Where the allowed users come from */
export type CredentialSource
  = | { kind: 'htpasswd', path: string }
    | { kind: 'user', user: string, password: string }

/** The game server's admin token, as core hands it to plugins: checked without being told */
export interface AdminToken {
  readonly configured: boolean
  matches(candidate: string): boolean
}

export interface BasicAuthOptions {
  realm: string
  /** Users of the dashboard's own. Without any and without an admin token, only requests from this machine are let in */
  credentials?: CredentialSource
  /**
   * The game server's admin token. It logs in as the password, with any user name, and as `Authorization: Bearer <token>`,
   * so the dashboard needs no secret of its own.
   */
  adminToken?: AdminToken
  logger?: Logger
  /** How long a checked login is remembered, so bcrypt doesn't run on every poll. Default 10 minutes */
  cacheMs?: number
  /** Failed logins per address before it is locked out. Default 10 */
  maxFailures?: number
  /** How long failures count and a lockout lasts. Default 5 minutes */
  lockoutMs?: number
  now?(): number
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const BASIC_RE = /^Basic ([A-Z0-9+/=]+)$/i
const BEARER_RE = /^Bearer (\S+)$/i
/** Don't re-stat the htpasswd file more often than this */
const RELOAD_CHECK_MS = 2000

export function isLoopback(address: string | undefined): boolean {
  return LOOPBACK_ADDRESSES.has(address ?? '')
}

/**
 * `user:password` from an `Authorization: Basic …` header, or undefined if there is none or it is malformed.
 */
export function parseBasicAuth(header: string | undefined): { user: string, password: string } | undefined {
  const encoded = header ? BASIC_RE.exec(header.trim())?.[1] : undefined
  if (!encoded)
    return undefined

  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  if (colon < 0)
    return undefined

  return { user: decoded.slice(0, colon), password: decoded.slice(colon + 1) }
}

/**
 * HTTP Basic auth against an htpasswd file or a single user, as Express middleware.
 * Logins that passed are cached for a while, failures are throttled per client address,
 * and the htpasswd file is re-read when it changes.
 */
export default class BasicAuth {
  private users = new Map<string, PasswordVerifier>()
  private htpasswdMtime = -1
  private lastReloadCheck = -Infinity
  /** sha256 of user + password → when the login stops counting as checked */
  private verified = new Map<string, number>()
  private failures = new Map<string, { count: number, since: number }>()

  private readonly cacheMs: number
  private readonly maxFailures: number
  private readonly lockoutMs: number
  private readonly now: () => number

  constructor(private options: BasicAuthOptions) {
    this.cacheMs = options.cacheMs ?? 10 * 60 * 1000
    this.maxFailures = options.maxFailures ?? 10
    this.lockoutMs = options.lockoutMs ?? 5 * 60 * 1000
    this.now = options.now ?? Date.now

    const { credentials } = options
    if (credentials?.kind === 'user') {
      const { user, password } = credentials
      this.users.set(user, async candidate => safeEqual(candidate, password))
    }
    else if (credentials?.kind === 'htpasswd') {
      // Throws when the file can't be read, so a typo in the path fails at startup instead of locking everyone out
      this.reloadHtpasswd(true)
    }
  }

  /** Whether logins are checked at all, rather than only letting this machine in */
  get requiresLogin(): boolean {
    return !!this.options.credentials || !!this.options.adminToken?.configured
  }

  get userCount(): number {
    return this.users.size
  }

  readonly middleware = (req: Request, res: Response, next: NextFunction): void => {
    this.check(req, res).then((allowed) => {
      if (allowed)
        next()
    }, next)
  }

  private async check(req: Request, res: Response): Promise<boolean> {
    const address = req.socket.remoteAddress ?? 'unknown'

    if (!this.requiresLogin) {
      if (isLoopback(address))
        return true
      res.status(403).type('text/plain').send('Monitoring is only available from this machine until a login is configured, see the @mavonengine/http-monitoring README\n')
      return false
    }

    const lockedFor = this.lockedOutFor(address)
    if (lockedFor > 0) {
      res.setHeader('Retry-After', String(Math.ceil(lockedFor / 1000)))
      res.status(429).type('text/plain').send('Too many failed logins, try again later\n')
      return false
    }

    const admin = this.options.adminToken
    const bearer = BEARER_RE.exec(req.headers.authorization?.trim() ?? '')?.[1]
    const credentials = parseBasicAuth(req.headers.authorization)

    // The server's admin token: as a bearer token for tools, as the password (whatever the user name) for the browser
    const allowed = (bearer !== undefined && !!admin?.matches(bearer))
      || (!!credentials && (!!admin?.matches(credentials.password) || await this.verify(credentials.user, credentials.password)))
    if (allowed) {
      this.failures.delete(address)
      return true
    }

    if (credentials || bearer !== undefined) {
      this.recordFailure(address)
      this.options.logger?.warn(`Monitoring: failed login ${credentials ? `for "${credentials.user}"` : 'with a token'} from ${address}`)
    }

    res.setHeader('WWW-Authenticate', `Basic realm="${this.options.realm.replace(/"/g, '')}", charset="UTF-8"`)
    res.status(401).type('text/plain').send('Login required\n')
    return false
  }

  /**
   * Check a login, from the cache when it passed recently.
   */
  async verify(user: string, password: string): Promise<boolean> {
    this.reloadHtpasswdIfChanged()

    const verifyPassword = this.users.get(user)
    if (!verifyPassword)
      return false

    const key = createHash('sha256').update(user).update('\0').update(password).digest('base64')
    const until = this.verified.get(key)
    if (until !== undefined && until > this.now())
      return true

    if (!await verifyPassword(password))
      return false

    this.verified.set(key, this.now() + this.cacheMs)
    return true
  }

  private lockedOutFor(address: string): number {
    const entry = this.failures.get(address)
    if (!entry)
      return 0

    const elapsed = this.now() - entry.since
    if (elapsed >= this.lockoutMs) {
      this.failures.delete(address)
      return 0
    }

    return entry.count >= this.maxFailures ? this.lockoutMs - elapsed : 0
  }

  private recordFailure(address: string) {
    const entry = this.failures.get(address)
    if (entry)
      entry.count++
    else
      this.failures.set(address, { count: 1, since: this.now() })

    // Don't let an address scan grow this forever
    if (this.failures.size > 10000)
      this.failures.delete(this.failures.keys().next().value!)
  }

  private reloadHtpasswdIfChanged() {
    if (this.options.credentials?.kind !== 'htpasswd')
      return
    if (this.now() - this.lastReloadCheck < RELOAD_CHECK_MS)
      return

    try {
      this.reloadHtpasswd(false)
    }
    catch (err) {
      // Keep the users we have rather than locking everyone out over a half-written file
      this.options.logger?.warn(`Monitoring: could not re-read the htpasswd file: ${(err as Error).message}`)
    }
  }

  private reloadHtpasswd(initial: boolean) {
    const credentials = this.options.credentials as Extract<CredentialSource, { kind: 'htpasswd' }>
    this.lastReloadCheck = this.now()

    const { mtimeMs } = statSync(credentials.path)
    if (mtimeMs === this.htpasswdMtime)
      return

    const { users, warnings } = parseHtpasswd(readFileSync(credentials.path, 'utf8'), credentials.path)
    warnings.forEach(warning => this.options.logger?.warn(`Monitoring: ${warning}`))

    this.users = users
    this.htpasswdMtime = mtimeMs
    // Removed users and changed passwords must not stay logged in through the cache
    this.verified.clear()

    if (!initial)
      this.options.logger?.info(`Monitoring: reloaded ${credentials.path}, ${users.size} user${users.size === 1 ? '' : 's'}`)
  }
}
