import type { ServerChannel } from '@geckos.io/server'
import type { AuthorizeResult, Identity, ServerPlugin, ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { Express, Request, RequestHandler, Response } from 'express'
import type { AccountInfo, SessionResponse } from './protocol'
import type { Account } from './store'
import { randomInt } from 'node:crypto'
import process from 'node:process'
import { decoyHash, hashPassword, verifyPassword } from './password'
import { DEFAULT_PATH, emailProblem, PASSWORD_PROVIDER, passwordProblem, usernameProblem } from './protocol'
import RateLimit from './rateLimit'
import AuthStore, { hashToken, migrations } from './store'

export type { AccountInfo, SessionResponse } from './protocol'
export type { Account, AccountListing } from './store'

export interface AuthOptions {
  /** Where the routes are. Default `/api/auth` */
  path: string
  /** Whether players can make an account with a username and password. Default true */
  registration: boolean
  /** How long a session lasts without being used, in days. Every use moves it on. Default 30 */
  sessionDays: number
  /**
   * Let players play as guests: `POST /guest` makes a guest account with a session, which connects as that account
   * and can be registered later without losing what the game kept for it. Default false
   */
  guests: boolean
  /** How long a guest session lasts without being used, in days. Once it ran out the guest account is deleted. Default 30 */
  guestDays: number
  /** Guest accounts one address may make per hour. Default 20 */
  guestsPerHour: number
  /**
   * Let clients without any session in, without an identity, outside production only, e.g. to open the editor without
   * logging in. Default false
   */
  devGuests: boolean
  /** Failed logins per address and username before they are refused for a while. Default 10 */
  loginAttempts: number
  /** How long those failed logins count, in minutes. Default 15 */
  loginWindowMinutes: number
}

export const DEFAULT_OPTIONS: AuthOptions = {
  path: DEFAULT_PATH,
  registration: true,
  sessionDays: 30,
  guests: false,
  guestDays: 30,
  guestsPerHour: 20,
  devGuests: false,
  loginAttempts: 10,
  loginWindowMinutes: 15,
}

const DAY_MS = 24 * 60 * 60 * 1000
const MAX_BODY_BYTES = 16 * 1024
const MAX_NAME_LENGTH = 64
const BEARER_RE = /^Bearer\s+(\S+)$/i
const TRAILING_SLASHES_RE = /\/+$/
// eslint-disable-next-line no-control-regex
const CONTROL_CHARS_RE = /[\u0000-\u001F\u007F]/g
const HOUR_MS = 60 * 60 * 1000

/** A request the plugin turns down, with the HTTP status that says why */
export class AuthError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

export function parseOptions(raw: Record<string, unknown> = {}): AuthOptions {
  const positive = (value: unknown, fallback: number) => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback
  return {
    path: typeof raw.path === 'string' && raw.path.startsWith('/') ? raw.path.replace(TRAILING_SLASHES_RE, '') : DEFAULT_OPTIONS.path,
    registration: typeof raw.registration === 'boolean' ? raw.registration : DEFAULT_OPTIONS.registration,
    sessionDays: positive(raw.sessionDays, DEFAULT_OPTIONS.sessionDays),
    guests: raw.guests === true,
    guestDays: positive(raw.guestDays, DEFAULT_OPTIONS.guestDays),
    guestsPerHour: Math.floor(positive(raw.guestsPerHour, DEFAULT_OPTIONS.guestsPerHour)),
    devGuests: raw.devGuests === true,
    loginAttempts: Math.floor(positive(raw.loginAttempts, DEFAULT_OPTIONS.loginAttempts)),
    loginWindowMinutes: positive(raw.loginWindowMinutes, DEFAULT_OPTIONS.loginWindowMinutes),
  }
}

interface AuthState {
  ctx?: ServerPluginContext
  store?: AuthStore
  options: AuthOptions
  /** Open channels per account, to close them when it is disabled or logged out everywhere */
  channels: Map<string, Set<ServerChannel>>
  /** Failed logins per address and username */
  failedLogins: RateLimit
  /** Guest accounts made per address */
  guestsMade: RateLimit
  /** Deletes the guest accounts nobody can reach any more */
  sweeper?: ReturnType<typeof setInterval>
  warnedNoDatabase?: boolean
  hooks?: AuthHooks
}

const STATES = Symbol.for('mavonengine.auth.states')

/** Kept on globalThis, so a login plugin that bundles its own copy of this file still finds the same accounts */
function stateOf(server: object): AuthState {
  const registry = ((globalThis as Record<symbol, unknown>)[STATES] ??= new WeakMap()) as WeakMap<object, AuthState>
  let state = registry.get(server)
  if (!state) {
    state = { options: DEFAULT_OPTIONS, channels: new Map(), ...limits(DEFAULT_OPTIONS) }
    registry.set(server, state)
  }
  return state
}

function limits(options: AuthOptions) {
  return {
    failedLogins: new RateLimit(options.loginAttempts, options.loginWindowMinutes * 60_000),
    guestsMade: new RateLimit(options.guestsPerHour, HOUR_MS),
  }
}

/** How long a session of `account` lasts without being used: shorter or longer for guests, by `guestDays` */
function lifetimeOf(state: AuthState) {
  return (account: Account) => (account.guest ? state.options.guestDays : state.options.sessionDays) * DAY_MS
}

/** The address a request came from, as Express sees it (behind a proxy, set `trust proxy`) */
function addressOf(req: Request): string {
  return req.ip ?? req.socket.remoteAddress ?? ''
}

function running(state: AuthState): AuthStore {
  if (!state.store)
    throw new AuthError(503, 'Accounts are unavailable: the auth plugin has no database (install a database plugin such as @mavonengine/sqlite)')
  return state.store
}

/** What the game server and its plugins may know of an account: its identity. No email */
function publicAccount(account: Account): AccountInfo {
  return account.guest ? { id: account.id, name: account.name, guest: true } : { id: account.id, name: account.name }
}

/** What the player itself is told of its account: with its email */
function ownAccount(account: Account): AccountInfo {
  return { ...publicAccount(account), email: account.email }
}

/** An email from a request or a provider, trimmed, or undefined for none. Throws a 400 for one that can't be used */
function emailFrom(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '')
    return undefined
  const problem = emailProblem(value)
  if (problem)
    throw new AuthError(400, problem)
  return (value as string).trim()
}

/** A name from a provider made safe to show: no control characters, not too long, never empty */
function cleanName(name: string | undefined): string {
  const cleaned = (name ?? '').replace(CONTROL_CHARS_RE, ' ').trim().slice(0, MAX_NAME_LENGTH)
  return cleaned || 'player'
}

async function startSession(state: AuthState, store: AuthStore, account: Account): Promise<SessionResponse> {
  const { token, expiresAt } = await store.createSession(account.id, lifetimeOf(state)(account))
  return { token, account: ownAccount(account), expiresAt }
}

/** Close the game connections of an account: it reconnects only with a session that still works */
/**
 * Which session a connection was made with, as its identity says: a short piece of the token's hash, which tells
 * sessions apart without being any use to log in with
 */
function sessionKey(token: string): string {
  return hashToken(token).slice(0, 16)
}

/**
 * Close the game connections of an account, or only those `which` picks by the session they were made with:
 * they reconnect only with a session that still works
 */
function kick(state: AuthState, accountId: string, which?: (session: unknown) => boolean): number {
  const channels = state.channels.get(accountId)
  if (!channels)
    return 0

  let closed = 0
  for (const channel of [...channels]) {
    if (which && !which(state.ctx?.identity(channel)?.session))
      continue
    void channel.close().catch(() => {})
    channels.delete(channel)
    closed++
  }
  if (channels.size === 0)
    state.channels.delete(accountId)
  return closed
}

/**
 * What a game or a login plugin does with the accounts. Get it with `auth(server)`, e.g. `auth(ctx.server)` in a
 * plugin. The calls answer once the auth plugin runs with a database, and reject with an `AuthError` (status 503) before.
 */
export interface AuthHooks {
  /**
   * Log in through another provider, e.g. from a Discord login plugin once Discord said who the user is:
   * the account linked to `externalId` gets a new session, and a new account is made for a user seen the first time.
   * With `linkTo`, a new user is linked to that account instead, so one player logs in either way. A guest account
   * linked that way becomes a full one, named after the profile, and keeps its id.
   * The profile's `email` is kept on an account that has none, when no other account has it; `emailVerified` says the
   * provider checked it is the user's.
   * Rejects with 403 for a disabled account and 409 when `linkTo` asks to link a user another account already has.
   */
  signIn(provider: string, externalId: string, profile?: { name?: string, email?: string, emailVerified?: boolean }, options?: { linkTo?: string }): Promise<SessionResponse>
  /** The account a session token is logged in as. Undefined for an unknown or expired token */
  accountOf(token: string): Promise<Account | undefined>
  account(id: string): Promise<Account | undefined>
  /** Disable the account: it can't log in or connect, its sessions end and its game connections close */
  disable(accountId: string): Promise<boolean>
  enable(accountId: string): Promise<boolean>
  /** Log the account out everywhere and close its game connections. Returns how many sessions it had */
  endSessions(accountId: string): Promise<number>
  /** Whether the plugin runs with a database */
  readonly running: boolean
}

export function auth(server: object): AuthHooks {
  const state = stateOf(server)

  state.hooks ??= {
    async signIn(provider, externalId, profile = {}, options = {}) {
      if (!provider || provider === PASSWORD_PROVIDER)
        throw new AuthError(400, `Sign in with a password through ${state.options.path}/login, not signIn()`)
      if (!externalId)
        throw new AuthError(400, 'signIn() needs the provider\'s id of the user')

      const store = running(state)
      // A provider's email that can't be used is left out rather than failing the login
      const email = emailProblem(profile.email) ? undefined : profile.email!.trim()
      return store.transaction(async (tx) => {
        const freeEmail = async (accountId?: string) => email && !await tx.emailTaken(email, accountId) ? email : undefined
        const known = await tx.identity(provider, externalId)
        let account: Account | undefined
        if (known) {
          if (options.linkTo && options.linkTo !== known.accountId)
            throw new AuthError(409, `This ${provider} user is already linked to another account`)
          account = await tx.account(known.accountId)
        }
        else if (options.linkTo) {
          account = await tx.account(options.linkTo)
          if (!account)
            throw new AuthError(404, 'There is no account to link to')
          await tx.addIdentity({ provider, externalId, accountId: account.id, secret: null })
          if (account.guest) {
            const name = cleanName(profile.name)
            await tx.upgradeGuest(account.id, name)
            account = { ...account, name, guest: false }
          }
          const linkedEmail = account.email ? undefined : await freeEmail(account.id)
          if (linkedEmail) {
            await tx.setEmail(account.id, linkedEmail, { verified: profile.emailVerified === true })
            account = { ...account, email: linkedEmail }
          }
        }
        else {
          account = await tx.createAccount(cleanName(profile.name), { email: await freeEmail(), emailVerified: profile.emailVerified === true })
          await tx.addIdentity({ provider, externalId, accountId: account.id, secret: null })
        }

        if (!account)
          throw new AuthError(500, 'The identity belongs to an account that doesn\'t exist')
        if (account.disabledAt)
          throw new AuthError(403, 'This account is disabled')
        return startSession(state, tx, account)
      })
    },
    accountOf: token => running(state).useSession(token, lifetimeOf(state)),
    account: id => running(state).account(id),
    async disable(accountId) {
      const store = running(state)
      const found = await store.setDisabled(accountId, true)
      if (found) {
        await store.deleteSessionsOf(accountId)
        kick(state, accountId)
      }
      return found
    },
    enable: accountId => running(state).setDisabled(accountId, false),
    async endSessions(accountId) {
      const ended = await running(state).deleteSessionsOf(accountId)
      kick(state, accountId)
      return ended
    },
    get running() {
      return !!state.store
    },
  }

  return state.hooks
}

function bearer(header: string | undefined): string | undefined {
  return header?.match(BEARER_RE)?.[1]
}

/** Registered symbol core reads a route's description from */
const ROUTE_DOC = Symbol.for('mavonengine.routeDoc')

function describe(doc: { summary: string, description?: string, params?: Record<string, string>, response?: string }): RequestHandler {
  const handler: RequestHandler = (_req, _res, next) => next()
  ;(handler as unknown as Record<symbol, unknown>)[ROUTE_DOC] = doc
  return handler
}

function readJson(req: Request): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        reject(new AuthError(413, 'Body too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        const parsed: unknown = body ? JSON.parse(body) : {}
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed))
          throw new Error('not an object')
        resolve(parsed as Record<string, unknown>)
      }
      catch {
        reject(new AuthError(400, 'Expected a JSON object'))
      }
    })
    req.on('error', reject)
  })
}

/** Run a route, answering an AuthError with its status and anything else with 500 */
function route(state: AuthState, handle: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res) => {
    handle(req, res).catch((err: unknown) => {
      if (err instanceof AuthError) {
        res.status(err.status).json({ error: err.message })
        return
      }
      state.ctx?.logger?.error(`Auth: ${req.method} ${req.path} failed: ${(err as Error)?.stack ?? err}`)
      res.status(500).json({ error: 'Something went wrong' })
    })
  }
}

/** The account the request's bearer token is logged in as, or a 401 */
async function requireSession(state: AuthState, req: Request): Promise<{ token: string, account: Account }> {
  const token = bearer(req.headers.authorization)
  const account = token && await running(state).useSession(token, lifetimeOf(state))
  if (!token || !account)
    throw new AuthError(401, 'Not logged in, or the session ran out')
  if (account.disabledAt)
    throw new AuthError(403, 'This account is disabled')
  return { token, account }
}

export function mountAuthApi(app: Express, ctx: ServerPluginContext, state: AuthState) {
  const { path } = state.options
  const body = readJson

  app.post(`${path}/register`, describe({
    summary: 'Make an account with a username and password',
    description: 'Send `{ "username": "...", "password": "...", "email": "..." }`, the email optional. The username is 3 to 32 letters, digits, `_`, `.` or `-` and unique regardless of case; the password at least 8 characters; the email unique regardless of case. Sent with the session of a guest (`Authorization: Bearer <token>`), the guest account becomes this one, with the same id.',
    response: '201 with `{ token, account, expiresAt }`, logged in. 400 for a name, password or email that can\'t be used, 409 for a taken name or email, 403 when registration is off',
  }), route(state, async (req, res) => {
    if (!state.options.registration)
      throw new AuthError(403, 'Registration is turned off on this server')

    const { username, password, email: rawEmail } = await body(req)
    const problem = usernameProblem(username) ?? passwordProblem(password)
    if (problem)
      throw new AuthError(400, problem)
    const email = emailFrom(rawEmail)

    const store = running(state)
    const key = (username as string).toLowerCase()
    const secret = await hashPassword(password as string)
    // A guest who registers keeps its account, and so what the game kept for it
    const token = bearer(req.headers.authorization)
    const current = token ? await store.useSession(token, lifetimeOf(state)) : undefined
    const guest = current?.guest && !current.disabledAt ? current : undefined

    const session = await store.transaction(async (tx) => {
      if (await tx.identity(PASSWORD_PROVIDER, key))
        throw new AuthError(409, 'That username is taken')
      if (email && await tx.emailTaken(email, guest?.id))
        throw new AuthError(409, 'That email is in use')
      let account: Account
      if (guest) {
        await tx.upgradeGuest(guest.id, username as string)
        if (email)
          await tx.setEmail(guest.id, email)
        account = { ...guest, name: username as string, guest: false, email: email ?? null, emailVerifiedAt: null }
      }
      else {
        account = await tx.createAccount(username as string, { email: email ?? null })
      }
      await tx.addIdentity({ provider: PASSWORD_PROVIDER, externalId: key, accountId: account.id, secret })
      return startSession(state, tx, account)
    }).catch(async (err: unknown) => {
      // Two registrations of one name or email at once: the second insert breaks the unique key
      if (!(err instanceof AuthError) && await store.identity(PASSWORD_PROVIDER, key))
        throw new AuthError(409, 'That username is taken')
      if (!(err instanceof AuthError) && email && await store.emailTaken(email))
        throw new AuthError(409, 'That email is in use')
      throw err
    })

    ctx.logger?.info(`Auth: ${session.account.name} registered${guest ? `, was guest ${guest.name}` : ''}`)
    res.status(201).json(session)
  }))

  app.post(`${path}/guest`, describe({
    summary: 'Play as a guest',
    description: `Makes a guest account, named like \`Guest-4821\`, and logs it in. It connects like any account, with \`guest: true\` in its identity, and becomes a full account when the player registers with its session. Its session lasts ${state.options.guestDays} days without being used, after which the account is deleted. One address may make ${state.options.guestsPerHour} an hour.`,
    response: '201 with `{ token, account, expiresAt }`. 403 when guests are off, 429 after too many from one address',
  }), route(state, async (req, res) => {
    if (!state.options.guests)
      throw new AuthError(403, 'Guests are turned off on this server')

    const address = addressOf(req)
    const wait = state.guestsMade.blocked(address)
    if (wait !== undefined) {
      res.setHeader('Retry-After', String(wait))
      throw new AuthError(429, `Too many guests from this address, try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}`)
    }

    const store = running(state)
    state.guestsMade.hit(address)
    const session = await store.transaction(async tx =>
      startSession(state, tx, await tx.createAccount(`Guest-${randomInt(1000, 10000)}`, { guest: true })))
    res.status(201).json(session)
  }))

  app.post(`${path}/login`, describe({
    summary: 'Log in with a username and password',
    description: `Send \`{ "username": "...", "password": "..." }\`. After ${state.options.loginAttempts} failed tries from one address for one username, that is refused for ${state.options.loginWindowMinutes} minutes.`,
    response: '`{ token, account, expiresAt }`. 401 for a wrong username or password, 403 for a disabled account, 429 after too many tries',
  }), route(state, async (req, res) => {
    const { username, password } = await body(req)
    if (typeof username !== 'string' || typeof password !== 'string' || password.length > 1024)
      throw new AuthError(400, 'Expected { username, password }')

    const key = username.toLowerCase()
    const limitKey = `${addressOf(req)}|${key}`
    const wait = state.failedLogins.blocked(limitKey)
    if (wait !== undefined) {
      res.setHeader('Retry-After', String(wait))
      throw new AuthError(429, `Too many failed logins, try again in ${Math.ceil(wait / 60)} minute${wait > 60 ? 's' : ''}`)
    }

    const store = running(state)
    const identity = await store.identity(PASSWORD_PROVIDER, key)
    // Checked against a decoy without the user, so an unknown name takes as long as a wrong password
    const valid = await verifyPassword(password, identity?.secret ?? await decoyHash())
    if (!identity || !valid) {
      state.failedLogins.hit(limitKey)
      throw new AuthError(401, 'Wrong username or password')
    }

    state.failedLogins.reset(limitKey)
    const account = await store.account(identity.accountId)
    if (!account)
      throw new AuthError(500, 'The login belongs to an account that doesn\'t exist')
    if (account.disabledAt)
      throw new AuthError(403, 'This account is disabled')
    res.json(await startSession(state, store, account))
  }))

  app.post(`${path}/logout`, describe({
    summary: 'End this session',
    description: 'With `Authorization: Bearer <token>`. The game connections made with this session close; those of the account\'s other sessions stay. A guest that logs out loses its account: nothing else logs in to it.',
    response: '204, also when the session had already ended',
  }), route(state, async (req, res) => {
    const token = bearer(req.headers.authorization)
    if (token) {
      const store = running(state)
      const account = await store.useSession(token, 0)
      await store.deleteSession(token)
      if (account) {
        const session = sessionKey(token)
        kick(state, account.id, key => key === session)
      }
      if (account?.guest)
        await store.deleteAbandonedGuests()
    }
    res.status(204).end()
  }))

  app.get(`${path}/me`, describe({
    summary: 'The account this session is logged in as',
    description: 'With `Authorization: Bearer <token>`. Moves the session on, like connecting does.',
    response: '`{ account }` with its id, name and email, 401 when not logged in',
  }), route(state, async (req, res) => {
    const { account } = await requireSession(state, req)
    res.json({ account: ownAccount(account) })
  }))

  app.post(`${path}/password`, describe({
    summary: 'Change the password',
    description: 'With `Authorization: Bearer <token>`, send `{ "current": "...", "password": "..." }`. Every other session of the account ends, and the game connections made with them close.',
    response: '204. 401 for a wrong current password, 400 for a new one that can\'t be used, 409 for an account without a password',
  }), route(state, async (req, res) => {
    const { token, account } = await requireSession(state, req)
    const { current, password } = await body(req)
    const problem = passwordProblem(password)
    if (problem)
      throw new AuthError(400, problem)

    const store = running(state)
    const identity = await store.identityOf(account.id, PASSWORD_PROVIDER)
    if (!identity?.secret)
      throw new AuthError(409, 'This account logs in without a password')
    if (typeof current !== 'string' || !await verifyPassword(current, identity.secret))
      throw new AuthError(401, 'The current password is wrong')

    await store.setSecret(PASSWORD_PROVIDER, identity.externalId, await hashPassword(password as string))
    // Wherever else it was logged in, maybe by whoever knew the old password, ends. This device stays
    await store.deleteSessionsOf(account.id, token)
    const session = sessionKey(token)
    kick(state, account.id, key => key !== session)
    res.status(204).end()
  }))

  mountAdminApi(app, ctx, state)
}

function mountAdminApi(app: Express, ctx: ServerPluginContext, state: AuthState) {
  const { path } = state.options
  const admin = ctx.requireAdmin
  const hooks = auth(ctx.server)

  app.get(`${path}/accounts`, admin, describe({
    summary: 'The accounts, newest first',
    description: 'Paged with `?limit=` (default 50, at most 500) and `?offset=`.',
    response: '`{ accounts, total }`, each account with `id`, `name`, `createdAt`, `disabledAt`, `providers` and `sessions`',
  }), route(state, async (req, res) => {
    const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 50))
    const offset = Math.max(0, Number(req.query.offset) || 0)
    res.json(await running(state).listAccounts(limit, offset))
  }))

  app.post(`${path}/accounts/:id/disable`, admin, describe({
    summary: 'Disable an account',
    description: 'It can\'t log in or connect any more, its sessions end and its game connections close.',
    params: { id: 'Id of the account' },
    response: '`{ disabled: true }`, 404 for an unknown account',
  }), route(state, async (req, res) => {
    const id = String(req.params.id)
    if (!await hooks.disable(id))
      throw new AuthError(404, 'There is no such account')
    ctx.logger?.info(`Auth: disabled account ${id}`)
    res.json({ disabled: true })
  }))

  app.post(`${path}/accounts/:id/enable`, admin, describe({
    summary: 'Let a disabled account log in again',
    params: { id: 'Id of the account' },
    response: '`{ disabled: false }`, 404 for an unknown account',
  }), route(state, async (req, res) => {
    if (!await hooks.enable(String(req.params.id)))
      throw new AuthError(404, 'There is no such account')
    res.json({ disabled: false })
  }))

  app.delete(`${path}/accounts/:id/sessions`, admin, describe({
    summary: 'Log an account out everywhere',
    description: 'Its sessions end and its game connections close. It can log in again.',
    params: { id: 'Id of the account' },
    response: '`{ ended }`, how many sessions it had',
  }), route(state, async (req, res) => {
    res.json({ ended: await hooks.endSessions(String(req.params.id)) })
  }))
}

/**
 * Decide whether a client may connect: core calls this with the Authorization header of the connection request
 */
async function authorizeConnection(state: AuthState, authorization: string | undefined, ctx: ServerPluginContext): Promise<AuthorizeResult> {
  if (!state.store) {
    if (!state.warnedNoDatabase) {
      state.warnedNoDatabase = true
      ctx.logger?.error('Auth: no database, so nobody can log in and every client is turned away. Install a database plugin such as @mavonengine/sqlite')
    }
    return 503
  }

  const token = bearer(authorization)
  if (!token)
    return state.options.devGuests && process.env.NODE_ENV !== 'production'

  const account = await state.store.useSession(token, lifetimeOf(state))
  if (!account)
    return 401
  if (account.disabledAt)
    return 403
  // `session` tells this account's connections apart, to close those of a session that logs out
  return { ...publicAccount(account), session: sessionKey(token) } satisfies Identity
}

/** Forget sessions that ran out and the guest accounts nobody can reach any more */
async function sweep(state: AuthState) {
  const store = state.store
  if (!store)
    return
  try {
    const expired = await store.deleteExpiredSessions()
    const guests = await store.deleteAbandonedGuests()
    if (expired || guests)
      state.ctx?.logger?.info(`Auth: forgot ${expired} expired session${expired === 1 ? '' : 's'} and ${guests} guest account${guests === 1 ? '' : 's'}`)
  }
  catch (err) {
    state.ctx?.logger?.error(`Auth: could not clean up sessions: ${(err as Error)?.message ?? err}`)
  }
}

declare module '@mavonengine/core/Plugins/types' {
  interface ServerPluginApis {
    '@mavonengine/auth': AuthHooks
  }
}

export default {
  name: 'Auth',
  migrations,
  /** Other plugins get `auth(server)` as `ctx.plugin('@mavonengine/auth')` */
  api(ctx: ServerPluginContext): AuthHooks {
    return auth(ctx.server)
  },
  async setup(ctx: ServerPluginContext) {
    const state = stateOf(ctx.server)
    state.ctx = ctx
    state.options = parseOptions(ctx.options)
    Object.assign(state, limits(state.options))
    if (!ctx.db) {
      ctx.logger?.error('Auth: no database, so nobody can log in and every client is turned away. Install a database plugin such as @mavonengine/sqlite')
      state.warnedNoDatabase = true
      return
    }

    state.store = new AuthStore(ctx.db, name => ctx.table(name))
    if (state.options.devGuests && process.env.NODE_ENV !== 'production')
      ctx.logger?.info('Auth: clients without a session get in as guests (devGuests), which a production server doesn\'t allow')
    if (state.options.guests)
      ctx.logger?.info(`Auth: players can play as guests (POST ${state.options.path}/guest)`)
    await sweep(state)
    state.sweeper = setInterval(() => void sweep(state), HOUR_MS)
    state.sweeper.unref?.()
  },
  http(app: Express, ctx: ServerPluginContext) {
    mountAuthApi(app, ctx, stateOf(ctx.server))
  },
  authorize(authorization: string | undefined, _request: unknown, ctx: ServerPluginContext) {
    return authorizeConnection(stateOf(ctx.server), authorization, ctx)
  },
  onConnection(channel: ServerChannel, _client: unknown, ctx: ServerPluginContext) {
    const identity = ctx.identity(channel)
    if (!identity)
      return
    const state = stateOf(ctx.server)
    let channels = state.channels.get(identity.id)
    if (!channels)
      state.channels.set(identity.id, channels = new Set())
    channels.add(channel)
  },
  onDisconnect(channel: ServerChannel, ctx: ServerPluginContext) {
    const identity = ctx.identity(channel)
    const state = stateOf(ctx.server)
    const channels = identity && state.channels.get(identity.id)
    if (!channels)
      return
    channels.delete(channel)
    if (channels.size === 0)
      state.channels.delete(identity.id)
  },
  destroy(ctx: ServerPluginContext) {
    const state = stateOf(ctx.server)
    clearInterval(state.sweeper)
    state.sweeper = undefined
    state.store = undefined
    state.ctx = undefined
    state.channels.clear()
    state.failedLogins.clear()
    state.guestsMade.clear()
  },
} satisfies ServerPlugin
