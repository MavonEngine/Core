import type { ClientPlugin, ClientPluginContext } from '@mavonengine/core/Plugins/types'
import type { AccountInfo, AuthErrorResponse, SessionResponse, TokenResponse } from './protocol'
import { DEFAULT_PATH } from './protocol'

export type { AccountInfo, SessionResponse } from './protocol'

/** Where the session is kept in the browser */
export const STORAGE_KEY = 'mavonengine.auth.session'

/** Dispatched on `window` when the player logs in or out, with the account (or null) as `detail` */
export const AUTH_EVENT = 'mavonengine:auth'

interface StoredSession {
  token: string
  account: AccountInfo
  expiresAt: string
}

/** A request the server turned down, with its HTTP status and what it said */
export class AuthRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

const TRAILING_SLASHES_RE = /\/+$/

let basePath = DEFAULT_PATH

function read(): StoredSession | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    const session = raw
      ? JSON.parse(raw) as StoredSession
      : undefined
    return session && typeof session.token === 'string'
      ? session
      : undefined
  }
  catch {
    // Storage blocked, e.g. in a private window, or what was stored isn't ours
    return undefined
  }
}

function write(session: StoredSession | undefined) {
  try {
    if (session)
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session))
    else
      localStorage.removeItem(STORAGE_KEY)
  }
  catch {
    // Not kept: the player logs in again next time
  }
  window.dispatchEvent(new CustomEvent(AUTH_EVENT, { detail: session?.account ?? null }))
}

async function call<T>(method: string, path: string, body?: object, token = read()?.token): Promise<T | undefined> {
  const headers: Record<string, string> = {}
  if (body)
    headers['Content-Type'] = 'application/json'
  if (token)
    headers.Authorization = `Bearer ${token}`

  const res = await fetch(`${basePath}${path}`, {
    method,
    headers,
    body: body
      ? JSON.stringify(body)
      : undefined,
  })
  if (res.status === 204)
    return undefined
  const json = await res.json().catch(() => ({})) as T & Partial<AuthErrorResponse>
  if (!res.ok)
    throw new AuthRequestError(res.status, json.error ?? `${res.status} ${res.statusText}`)
  return json
}

function keep(session: SessionResponse): AccountInfo {
  write({ token: session.token, account: session.account, expiresAt: session.expiresAt })
  return session.account
}

/**
 * Make an account and log in with it, with an email if given. Logged in as a guest, the guest account becomes this
 * one. Rejects with an `AuthRequestError`, e.g. 409 for a taken name or email
 */
export async function register(username: string, password: string, email?: string): Promise<AccountInfo> {
  return keep((await call<SessionResponse>('POST', '/register', email
    ? { username, password, email }
    : { username, password }))!)
}

/**
 * Play as a guest: the server makes a guest account (`account.guest` is true) and logs it in. It stays the same account
 * while this browser keeps the session; `register()` from it keeps the account, and so the player's progress.
 * Rejects with an `AuthRequestError`, 403 when the server takes no guests
 */
export async function playAsGuest(): Promise<AccountInfo> {
  return keep((await call<SessionResponse>('POST', '/guest'))!)
}

/** Log in. Rejects with an `AuthRequestError`: 401 for a wrong username or password, 429 after too many tries */
export async function login(username: string, password: string): Promise<AccountInfo> {
  return keep((await call<SessionResponse>('POST', '/login', { username, password }))!)
}

/** End the session, on the server too when it can be reached. A guest that logs out loses its account */
export async function logout(): Promise<void> {
  const token = read()?.token
  write(undefined)
  if (token)
    await call('POST', '/logout', undefined, token).catch(() => {})
}

/**
 * Change the password. Every other device the account is logged in on is logged out. Rejects with an
 * `AuthRequestError`, 401 for a wrong current password
 */
export async function changePassword(current: string, password: string): Promise<void> {
  await call('POST', '/password', { current, password })
}

/** Keep what the server said of the logged in account, e.g. after its email changed or was confirmed */
function remember(account: AccountInfo) {
  const session = read()
  if (session && session.account.id === account.id)
    write({ ...session, account })
}

/**
 * Change the account's email, or take it away with null. The new one isn't confirmed: the server mails a link to
 * confirm it, when it can mail. Rejects with an `AuthRequestError`, 409 when another account has it
 */
export async function changeEmail(email: string | null): Promise<AccountInfo> {
  const { account } = (await call<TokenResponse>('POST', '/email', { email }))!
  remember(account)
  return account
}

/** Mail a new link to confirm the account's email. Rejects with an `AuthRequestError`, 429 when one went out a moment ago */
export async function resendVerification(): Promise<void> {
  await call('POST', '/verify-email/send')
}

/**
 * Confirm the email with the token of a mailed link, for a game with a confirmation page of its own (`verifyUrl` on
 * the server). Works without being logged in. Rejects with an `AuthRequestError`, 400 for a link that doesn't work
 */
export async function verifyEmail(token: string): Promise<AccountInfo> {
  const { account } = (await call<TokenResponse>('POST', '/verify-email', { token }, ''))!
  remember(account)
  return account
}

/**
 * Mail a link to reset the password to `email`. Resolves the same whether an account has it or not, so the page
 * should say "if an account has this email, …". Rejects with an `AuthRequestError`, 429 after too many
 */
export async function requestPasswordReset(email: string): Promise<void> {
  await call('POST', '/forgot-password', { email }, '')
}

/**
 * Set a new password with the token of a mailed link, for a game with a reset page of its own (`resetUrl` on the
 * server). Logs this browser in, and every other device out. Rejects with an `AuthRequestError`, 400 for a link that
 * doesn't work or a password that can't be used
 */
export async function resetPassword(token: string, password: string): Promise<AccountInfo> {
  return keep((await call<SessionResponse>('POST', '/reset-password', { token, password }, ''))!)
}

/** The account this browser is logged in as, as it was when it logged in. Undefined when it isn't */
export function currentAccount(): AccountInfo | undefined {
  return read()?.account
}

/**
 * Ask the server whether the session still works, and forget it when it doesn't. Resolves with the account,
 * or undefined when logged out
 */
export async function checkSession(): Promise<AccountInfo | undefined> {
  if (!read())
    return undefined
  try {
    const { account } = (await call<{ account: AccountInfo }>('GET', '/me'))!
    return account
  }
  catch (err) {
    if (err instanceof AuthRequestError && (err.status === 401 || err.status === 403))
      write(undefined)
    return undefined
  }
}

export default {
  name: 'Auth',
  setup(ctx: ClientPluginContext) {
    const path = ctx.options.path
    basePath = typeof path === 'string' && path.startsWith('/')
      ? path.replace(TRAILING_SLASHES_RE, '')
      : DEFAULT_PATH
  },
  // Read each time a NetworkManager is made, so connecting again after logging in sends the new session
  authorization() {
    const token = read()?.token
    return token
      ? `Bearer ${token}`
      : undefined
  },
} satisfies ClientPlugin
