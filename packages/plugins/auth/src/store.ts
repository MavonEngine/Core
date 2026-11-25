import type { PluginMigration } from '@mavonengine/core/Plugins/types'
import type { Kysely } from 'kysely'
import type { AccountInfo } from './protocol'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { sql } from 'kysely'

/**
 * The plugin's tables:
 * - `auth_accounts`: one per player, with the id everything else keys on. A guest account has no way to log in
 *   but its sessions, so it is deleted once they ran out
 * - `auth_identities`: the ways an account logs in, by provider: `password` with the username, `discord` with the
 *   Discord user id, … One account can have several, a provider's user belongs to one account
 * - `auth_sessions`: logged in clients, by the hash of their token, never the token itself
 * - `auth_tokens`: links mailed to confirm an email or reset a password, by the hash of their token too. Each is for
 *   the address it was mailed to, and works once
 *
 * Times are ISO strings, which sort like the times they are on every database.
 */

export interface Account extends Omit<AccountInfo, 'guest' | 'email'> {
  /** Optional, unique regardless of case. Only shown to the player itself and to admins, never in the game's identity */
  email: string | null
  /** When the player confirmed the email is theirs, with a mailed link, null until then. A new email isn't confirmed */
  emailVerifiedAt: string | null
  /** When a session was last started for it: a login, a registration, a guest playing */
  lastLoginAt: string | null
  createdAt: string
  /** When an admin disabled it, null while it may log in */
  disabledAt: string | null
  /** Made with `POST /guest`: no password nor linked login until the player registers */
  guest: boolean
}

export interface IdentityRow {
  provider: string
  externalId: string
  accountId: string
  /** The password hash for `password`, null for providers that check themselves */
  secret: string | null
}

export interface AccountListing extends Account {
  /** Providers it logs in with */
  providers: string[]
  /** The name it logs in with a password, null when it has no password */
  username: string | null
  sessions: number
}

/** Which accounts `listAccounts()` returns */
export interface AccountQuery {
  /** Part of the name, email or username, in any case, or the whole id */
  search?: string
  /** Only guests, or only disabled accounts */
  filter?: 'guests' | 'disabled'
}

export interface AccountStats {
  accounts: number
  guests: number
  disabled: number
  /** Sessions that haven't run out */
  sessions: number
}

/** Escapes LIKE's wildcards with `!`, which every database takes as an ESCAPE character */
const LIKE_SPECIAL_RE = /[!%_]/g

/** Names of the plugin's tables, from `ctx.table()` */
export type TableNames = (name: 'accounts' | 'identities' | 'sessions' | 'tokens') => string

/** What a mailed link is for */
export type TokenPurpose = 'verify-email' | 'reset-password'

export interface TokenRow {
  purpose: TokenPurpose
  accountId: string
  /** The address it was mailed to: it only works while the account still has it */
  email: string
  expiresAt: string
}

export const migrations: Record<string, PluginMigration> = {
  '001_init': {
    async up(db, { table }) {
      await db.schema.createTable(table('accounts'))
        .addColumn('id', 'varchar(36)', c => c.primaryKey())
        .addColumn('name', 'varchar(64)', c => c.notNull())
        // 0 or 1 rather than a boolean, which not every database driver binds
        .addColumn('guest', 'integer', c => c.notNull().defaultTo(0))
        .addColumn('created_at', 'varchar(32)', c => c.notNull())
        .addColumn('disabled_at', 'varchar(32)')
        .addColumn('email', 'varchar(254)')
        // The email lowercased, so one address can't be taken twice in another case. Unique; nulls don't count
        .addColumn('email_key', 'varchar(254)')
        .addColumn('email_verified_at', 'varchar(32)')
        .addColumn('last_login_at', 'varchar(32)')
        .execute()
      await db.schema.createIndex(`${table('accounts')}_email`).on(table('accounts')).column('email_key').unique().execute()

      await db.schema.createTable(table('identities'))
        .addColumn('provider', 'varchar(32)', c => c.notNull())
        // The username for `password`, lowercased, so names are unique regardless of case
        .addColumn('external_id', 'varchar(255)', c => c.notNull())
        .addColumn('account_id', 'varchar(36)', c => c.notNull().references(`${table('accounts')}.id`).onDelete('cascade'))
        .addColumn('secret', 'varchar(255)')
        .addColumn('created_at', 'varchar(32)', c => c.notNull())
        .addPrimaryKeyConstraint(`${table('identities')}_pk`, ['provider', 'external_id'])
        .execute()
      await db.schema.createIndex(`${table('identities')}_account`).on(table('identities')).column('account_id').execute()

      await db.schema.createTable(table('sessions'))
        .addColumn('token_hash', 'varchar(64)', c => c.primaryKey())
        .addColumn('account_id', 'varchar(36)', c => c.notNull().references(`${table('accounts')}.id`).onDelete('cascade'))
        .addColumn('created_at', 'varchar(32)', c => c.notNull())
        .addColumn('expires_at', 'varchar(32)', c => c.notNull())
        .addColumn('last_seen_at', 'varchar(32)', c => c.notNull())
        .execute()
      await db.schema.createIndex(`${table('sessions')}_account`).on(table('sessions')).column('account_id').execute()
    },
  },
  '002_tokens': {
    async up(db, { table }) {
      await db.schema.createTable(table('tokens'))
        .addColumn('token_hash', 'varchar(64)', c => c.primaryKey())
        .addColumn('purpose', 'varchar(32)', c => c.notNull())
        .addColumn('account_id', 'varchar(36)', c => c.notNull().references(`${table('accounts')}.id`).onDelete('cascade'))
        .addColumn('email', 'varchar(254)', c => c.notNull())
        .addColumn('created_at', 'varchar(32)', c => c.notNull())
        .addColumn('expires_at', 'varchar(32)', c => c.notNull())
        .execute()
      await db.schema.createIndex(`${table('tokens')}_account`).on(table('tokens')).columns(['account_id', 'purpose']).execute()
    },
  },
}

/** sha256 of a session token: what is stored and looked up, so a leaked database holds no usable tokens */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function toAccount(row: Record<string, any>): Account {
  return {
    id: row.id,
    name: row.name,
    email: row.email ?? null,
    emailVerifiedAt: row.email_verified_at ?? null,
    lastLoginAt: row.last_login_at ?? null,
    createdAt: row.created_at,
    disabledAt: row.disabled_at ?? null,
    guest: Number(row.guest) === 1,
  }
}

/** What an email is looked up and kept unique by */
export function emailKey(email: string): string {
  return email.trim().toLowerCase()
}

export default class AuthStore {
  constructor(readonly db: Kysely<any>, private readonly table: TableNames, private readonly now: () => Date = () => new Date()) {}

  /** Run `work` in a transaction where the database has them, with a store on it */
  transaction<T>(work: (store: AuthStore) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(trx => work(new AuthStore(trx, this.table, this.now)))
  }

  async createAccount(name: string, { guest = false, email = null as string | null, emailVerified = false } = {}): Promise<Account> {
    const now = this.now().toISOString()
    const account = {
      id: randomUUID(),
      name,
      guest: guest ? 1 : 0,
      email: email?.trim() ?? null,
      email_key: email
        ? emailKey(email)
        : null,
      email_verified_at: email && emailVerified
        ? now
        : null,
      last_login_at: null,
      created_at: now,
      disabled_at: null,
    }
    await this.db.insertInto(this.table('accounts')).values(account).execute()
    return toAccount(account)
  }

  async account(id: string): Promise<Account | undefined> {
    const row = await this.db.selectFrom(this.table('accounts')).selectAll().where('id', '=', id).executeTakeFirst()
    return row && toAccount(row)
  }

  async rename(id: string, name: string): Promise<void> {
    await this.db.updateTable(this.table('accounts')).set({ name }).where('id', '=', id).execute()
  }

  /** Whether another account than `exceptId` has this email, in any case */
  async emailTaken(email: string, exceptId?: string): Promise<boolean> {
    let query = this.db.selectFrom(this.table('accounts')).select('id').where('email_key', '=', emailKey(email))
    if (exceptId)
      query = query.where('id', '!=', exceptId)
    return !!await query.executeTakeFirst()
  }

  /** Give the account an email, or take it away with null. A new one isn't verified */
  async setEmail(id: string, email: string | null, { verified = false } = {}): Promise<void> {
    await this.db.updateTable(this.table('accounts')).set({
      email: email?.trim() ?? null,
      email_key: email
        ? emailKey(email)
        : null,
      email_verified_at: email && verified
        ? this.now().toISOString()
        : null,
    }).where('id', '=', id).execute()
  }

  /** The account with this email, in any case */
  async accountByEmail(email: string): Promise<Account | undefined> {
    const row = await this.db.selectFrom(this.table('accounts')).selectAll().where('email_key', '=', emailKey(email)).executeTakeFirst()
    return row && toAccount(row)
  }

  /** Mark the account's email confirmed, when it still is `email`. Returns whether it is */
  async markEmailVerified(id: string, email: string): Promise<boolean> {
    const result = await this.db.updateTable(this.table('accounts'))
      .set({
        email_verified_at: this.now().toISOString(),
      })
      .where('id', '=', id)
      .where('email_key', '=', emailKey(email))
      .executeTakeFirst()
    return Number(result.numUpdatedRows) > 0
  }

  /**
   * A token for a link to mail to `email`, for `purpose`, working for `lifetimeMs`. Links mailed before for the same
   * purpose stop working: only the latest does. Only the hash is kept
   */
  async createToken(accountId: string, purpose: TokenPurpose, email: string, lifetimeMs: number): Promise<string> {
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    await this.deleteTokensOf(accountId, purpose)
    await this.db.insertInto(this.table('tokens')).values({
      token_hash: hashToken(token),
      purpose,
      account_id: accountId,
      email: email.trim(),
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + lifetimeMs).toISOString(),
    }).execute()
    return token
  }

  /** What a token is, while it works: right purpose, not run out. Doesn't use it up */
  async token(token: string, purpose: TokenPurpose): Promise<TokenRow | undefined> {
    const row = await this.db.selectFrom(this.table('tokens'))
      .select([
        'purpose',
        'account_id',
        'email',
        'expires_at',
      ])
      .where('token_hash', '=', hashToken(token))
      .where('purpose', '=', purpose)
      .executeTakeFirst()
    if (!row || row.expires_at <= this.now().toISOString())
      return undefined
    return {
      purpose: row.purpose,
      accountId: row.account_id,
      email: row.email,
      expiresAt: row.expires_at,
    }
  }

  /**
   * Use a token up: what it is, if it worked, and it never works again. Of two uses at once, only one gets it
   */
  async useToken(token: string, purpose: TokenPurpose): Promise<TokenRow | undefined> {
    const found = await this.token(token, purpose)
    if (!found)
      return undefined
    const result = await this.db.deleteFrom(this.table('tokens')).where('token_hash', '=', hashToken(token)).executeTakeFirst()
    return Number(result.numDeletedRows) === 1
      ? found
      : undefined
  }

  /** Make the account's links stop working, those for `purpose` or all */
  async deleteTokensOf(accountId: string, purpose?: TokenPurpose): Promise<void> {
    let query = this.db.deleteFrom(this.table('tokens')).where('account_id', '=', accountId)
    if (purpose)
      query = query.where('purpose', '=', purpose)
    await query.execute()
  }

  /** Forget links that ran out. Returns how many */
  async deleteExpiredTokens(): Promise<number> {
    const result = await this.db.deleteFrom(this.table('tokens')).where('expires_at', '<=', this.now().toISOString()).executeTakeFirst()
    return Number(result.numDeletedRows)
  }

  /** A guest account becomes a full one, under a name of its own: same id, so what the game kept for it stays */
  async upgradeGuest(id: string, name: string): Promise<void> {
    await this.db.updateTable(this.table('accounts')).set({ name, guest: 0 }).where('id', '=', id).execute()
  }

  /** Disable or enable it again. Returns whether there is such an account */
  async setDisabled(id: string, disabled: boolean): Promise<boolean> {
    const result = await this.db.updateTable(this.table('accounts'))
      .set({
        disabled_at: disabled
          ? this.now().toISOString()
          : null,
      })
      .where('id', '=', id)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) > 0
  }

  async identity(provider: string, externalId: string): Promise<IdentityRow | undefined> {
    const row = await this.db.selectFrom(this.table('identities'))
      .select([
        'provider',
        'external_id',
        'account_id',
        'secret',
      ])
      .where('provider', '=', provider)
      .where('external_id', '=', externalId)
      .executeTakeFirst()
    return row && {
      provider: row.provider,
      externalId: row.external_id,
      accountId: row.account_id,
      secret: row.secret ?? null,
    }
  }

  /** The provider's identity of an account, e.g. its username for `password` */
  async identityOf(accountId: string, provider: string): Promise<IdentityRow | undefined> {
    const row = await this.db.selectFrom(this.table('identities'))
      .select([
        'provider',
        'external_id',
        'account_id',
        'secret',
      ])
      .where('account_id', '=', accountId)
      .where('provider', '=', provider)
      .executeTakeFirst()
    return row && {
      provider: row.provider,
      externalId: row.external_id,
      accountId: row.account_id,
      secret: row.secret ?? null,
    }
  }

  async addIdentity(identity: IdentityRow): Promise<void> {
    await this.db.insertInto(this.table('identities')).values({
      provider: identity.provider,
      external_id: identity.externalId,
      account_id: identity.accountId,
      secret: identity.secret,
      created_at: this.now().toISOString(),
    }).execute()
  }

  async setSecret(provider: string, externalId: string, secret: string): Promise<void> {
    await this.db.updateTable(this.table('identities')).set({ secret }).where('provider', '=', provider).where('external_id', '=', externalId).execute()
  }

  /** Log the account in: a new random token, of which only the hash is kept */
  async createSession(accountId: string, lifetimeMs: number): Promise<{ token: string, expiresAt: string }> {
    const token = randomBytes(32).toString('base64url')
    const now = this.now()
    const expiresAt = new Date(now.getTime() + lifetimeMs).toISOString()
    await this.db.insertInto(this.table('sessions')).values({
      token_hash: hashToken(token),
      account_id: accountId,
      created_at: now.toISOString(),
      expires_at: expiresAt,
      last_seen_at: now.toISOString(),
    }).execute()
    await this.db.updateTable(this.table('accounts')).set({
      last_login_at: now.toISOString(),
    }).where('id', '=', accountId).execute()
    return { token, expiresAt }
  }

  /**
   * The account a token is logged in as, while its session hasn't run out, and the session moved on by `lifetime`
   * from now (in ms, or as the account's lifetime). Undefined for an unknown or expired token. Disabled accounts are
   * returned too: the caller says why it refuses
   */
  async useSession(token: string, lifetime: number | ((account: Account) => number)): Promise<Account | undefined> {
    const hash = hashToken(token)
    const now = this.now()
    const row = await this.db.selectFrom(`${this.table('sessions')} as s`)
      .innerJoin(`${this.table('accounts')} as a`, 'a.id', 's.account_id')
      .select([
        'a.id',
        'a.name',
        'a.guest',
        'a.email',
        'a.email_verified_at',
        'a.last_login_at',
        'a.created_at',
        'a.disabled_at',
        's.expires_at',
      ])
      .where('s.token_hash', '=', hash)
      .executeTakeFirst()
    if (!row)
      return undefined

    if (row.expires_at <= now.toISOString()) {
      await this.deleteSession(token)
      return undefined
    }

    const account = toAccount(row)
    const lifetimeMs = typeof lifetime === 'number'
      ? lifetime
      : lifetime(account)
    await this.db.updateTable(this.table('sessions'))
      .set({
        last_seen_at: now.toISOString(),
        expires_at: new Date(now.getTime() + lifetimeMs).toISOString(),
      })
      .where('token_hash', '=', hash)
      .execute()
    return account
  }

  /** Returns whether there was such a session */
  async deleteSession(token: string): Promise<boolean> {
    const result = await this.db.deleteFrom(this.table('sessions')).where('token_hash', '=', hashToken(token)).executeTakeFirst()
    return Number(result.numDeletedRows) > 0
  }

  /** Log the account out everywhere, but for the session of `exceptToken`. Returns how many sessions ended */
  async deleteSessionsOf(accountId: string, exceptToken?: string): Promise<number> {
    let query = this.db.deleteFrom(this.table('sessions')).where('account_id', '=', accountId)
    if (exceptToken)
      query = query.where('token_hash', '!=', hashToken(exceptToken))
    const result = await query.executeTakeFirst()
    return Number(result.numDeletedRows)
  }

  /** Forget sessions that ran out. Returns how many */
  async deleteExpiredSessions(): Promise<number> {
    const result = await this.db.deleteFrom(this.table('sessions')).where('expires_at', '<=', this.now().toISOString()).executeTakeFirst()
    return Number(result.numDeletedRows)
  }

  /**
   * Delete the guest accounts without a session that still works: with no password nor linked login, nobody can
   * reach them again. Returns how many
   */
  async deleteAbandonedGuests(): Promise<number> {
    const live = this.db.selectFrom(this.table('sessions')).select('account_id').where('expires_at', '>', this.now().toISOString())
    const ids = (await this.db.selectFrom(this.table('accounts')).select('id').where('guest', '=', 1).where('id', 'not in', live).execute())
      .map(row => row.id as string)

    // In chunks, below the bound parameters a statement may have
    for (let i = 0; i < ids.length; i += 500) {
      const chunk = ids.slice(i, i + 500)
      await this.db.deleteFrom(this.table('sessions')).where('account_id', 'in', chunk).execute()
      await this.db.deleteFrom(this.table('tokens')).where('account_id', 'in', chunk).execute()
      await this.db.deleteFrom(this.table('identities')).where('account_id', 'in', chunk).execute()
      await this.db.deleteFrom(this.table('accounts')).where('id', 'in', chunk).execute()
    }
    return ids.length
  }

  /** A page of accounts, newest first, with how they log in and how many sessions they have */
  async listAccounts(limit: number, offset: number, query: AccountQuery = {}): Promise<{ accounts: AccountListing[], total: number }> {
    const accounts = this.table('accounts')
    const search = query.search?.trim()
    const where = (qb: any) => {
      let q = qb
      if (query.filter === 'guests')
        q = q.where('guest', '=', 1)
      else if (query.filter === 'disabled')
        q = q.where('disabled_at', 'is not', null)
      if (search) {
        const pattern = `%${search.toLowerCase().replace(LIKE_SPECIAL_RE, c => `!${c}`)}%`
        const usernames = this.db.selectFrom(this.table('identities')).select('account_id').where('provider', '=', 'password').where(sql<boolean>`external_id like ${pattern} escape '!'`)
        q = q.where((eb: any) => eb.or([
          eb('id', '=', search),
          sql<boolean>`lower(name) like ${pattern} escape '!'`,
          sql<boolean>`email_key like ${pattern} escape '!'`,
          eb('id', 'in', usernames),
        ]))
      }
      return q
    }

    const rows = await where(this.db.selectFrom(accounts).selectAll()).orderBy('created_at', 'desc').orderBy('id').limit(limit).offset(offset).execute() as Record<string, any>[]
    const total = await where(this.db.selectFrom(accounts).select((eb: any) => eb.fn.countAll().as('count'))).executeTakeFirstOrThrow() as { count: unknown }
    const ids = rows.map(row => row.id as string)
    if (ids.length === 0) {
      return {
        accounts: [],
        total: Number(total.count),
      }
    }

    const identities = await this.db.selectFrom(this.table('identities')).select(['account_id', 'provider', 'external_id']).where('account_id', 'in', ids).execute()
    const sessions = await this.db.selectFrom(this.table('sessions'))
      .select([
        'account_id',
        eb => eb.fn.countAll().as('count'),
      ])
      .where('account_id', 'in', ids)
      .where('expires_at', '>', this.now().toISOString())
      .groupBy('account_id')
      .execute()

    return {
      total: Number(total.count),
      accounts: rows.map((row) => {
        const own = identities.filter(identity => identity.account_id === row.id)
        return {
          ...toAccount(row),
          providers: own.map(identity => identity.provider as string).sort(),
          username: (own.find(identity => identity.provider === 'password')?.external_id as string | undefined) ?? null,
          sessions: Number(sessions.find(session => session.account_id === row.id)?.count ?? 0),
        }
      }),
    }
  }

  /** How many accounts, guests, disabled accounts and live sessions there are */
  async stats(): Promise<AccountStats> {
    const count = async (query: any) => Number((await query.select((eb: any) => eb.fn.countAll().as('count')).executeTakeFirstOrThrow()).count)
    const accounts = this.db.selectFrom(this.table('accounts'))
    return {
      accounts: await count(accounts),
      guests: await count(accounts.where('guest', '=', 1)),
      disabled: await count(accounts.where('disabled_at', 'is not', null)),
      sessions: await count(this.db.selectFrom(this.table('sessions')).where('expires_at', '>', this.now().toISOString())),
    }
  }
}
