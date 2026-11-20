/**
 * What the client and the server of @mavonengine/auth agree on: the routes' shapes and the rules for names
 * and passwords. Imports nothing, so the client bundle stays small.
 */

/** Where the routes are, unless `path` is set in the plugin's options */
export const DEFAULT_PATH = '/api/auth'

/** The provider of logins with a username and password */
export const PASSWORD_PROVIDER = 'password'

/** Letters, digits, `_`, `.` and `-`, 3 to 32 of them. Unique regardless of case */
export const USERNAME_RE = /^[\w.-]{3,32}$/

export const MIN_PASSWORD_LENGTH = 8
/** Hashing is deliberately slow: a cap keeps a huge password from tying the server up */
export const MAX_PASSWORD_LENGTH = 256

/** An account as players may see it: what the game server gets as the identity of a connection */
export interface AccountInfo {
  id: string
  name: string
  /** Set on a guest account, which keeps its progress only while the browser keeps its session: register to keep it for good */
  guest?: true
  /**
   * The account's email, only in answers to the player itself (register, login, `/me`), never in the identity the
   * game server and its plugins get. Null when it has none
   */
  email?: string | null
  /** Whether the player confirmed the email is theirs, with the link mailed to it. Next to `email` only */
  emailVerified?: boolean
}

/** What register and login answer with */
export interface SessionResponse {
  /** Send it as `Authorization: Bearer <token>`. Shown once: the server only keeps its hash */
  token: string
  account: AccountInfo
  /** ISO time it runs out unless used before: every use moves it on */
  expiresAt: string
}

/** What a route answers when it doesn't do what was asked */
export interface AuthErrorResponse {
  error: string
}

/** Longest email address there can be */
export const MAX_EMAIL_LENGTH = 254

// Something@something.something, without spaces: the rest only a mail to it can tell
const EMAIL_RE = /^[^\s@]+@[^\s@][^\s.@]*\.[^\s@]+$/

/** Why an email can't be used, or undefined when it can */
export function emailProblem(email: unknown): string | undefined {
  if (typeof email !== 'string' || email.trim().length > MAX_EMAIL_LENGTH || !EMAIL_RE.test(email.trim()))
    return 'That is no email address'
  return undefined
}

/** Why a username can't be used, or undefined when it can */
export function usernameProblem(username: unknown): string | undefined {
  if (typeof username !== 'string' || !USERNAME_RE.test(username))
    return 'A username is 3 to 32 letters, digits, "_", "." or "-"'
  return undefined
}

/** Why a password can't be used, or undefined when it can */
export function passwordProblem(password: unknown): string | undefined {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH)
    return `A password has at least ${MIN_PASSWORD_LENGTH} characters`
  if (password.length > MAX_PASSWORD_LENGTH)
    return `A password has at most ${MAX_PASSWORD_LENGTH} characters`
  return undefined
}

/** How long a link to confirm an email works */
export const VERIFY_EMAIL_HOURS = 24
/** How long a link to reset a password works */
export const RESET_PASSWORD_MINUTES = 60

/** What the token routes answer after confirming an email or setting a new password */
export interface TokenResponse {
  /** The account, as the player sees it */
  account: AccountInfo
}
