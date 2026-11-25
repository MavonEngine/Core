/**
 * Who a connected client is, as the project's auth plugin decided when it connected. It is stored as the channel's
 * `userData` and sent to the client too, so it only holds what the player may see.
 */
export interface Identity {
  /** Stable id of the account, the same on every connection */
  id: string
  /** Name to show, e.g. in chat or the dashboard */
  name?: string
  [key: string]: unknown
}

/** What a server plugin's `authorize()` returns: see `ServerPlugin.authorize` */
export type AuthorizeResult = Identity | boolean | number

export function isIdentity(value: unknown): value is Identity {
  return typeof value === 'object' && value !== null && typeof (value as Identity).id === 'string' && (value as Identity).id !== ''
}

/** The identity of a geckos channel (server or client), undefined when it connected without one */
export function identityOf(channel: { userData?: unknown } | undefined): Identity | undefined {
  const data = channel?.userData
  return isIdentity(data)
    ? data
    : undefined
}

/** The account of a player as the server's tools show it: no more than its id, name and whether it is a guest */
export interface PlayerAccount {
  id: string
  name: string | null
  guest: boolean
}

/** What the tools show of an identity, null without one */
export function accountOf(identity: Identity | undefined): PlayerAccount | null {
  return identity
    ? {
        id: identity.id,
        name: typeof identity.name === 'string'
          ? identity.name
          : null,
        guest: identity.guest === true,
      }
    : null
}
