import type { PluginMigration } from '@mavonengine/core/Plugins/types'
import type { Kysely } from 'kysely'
import type { AccountInfo } from './protocol'
import { createHash, randomBytes, randomUUID } from 'node:crypto'

/**
 * The plugin's tables:
 * - `auth_accounts`: one per player, with the id everything else keys on
 * - `auth_identities`: the ways an account logs in, by provider: `password` with the username, `discord` with the
 *   Discord user id, … One account can have several, a provider's user belongs to one account
 * - `auth_sessions`: logged in clients, by the hash of their token, never the token itself
 *
 * Times are ISO strings, which sort like the times they are on every database.
 */

export interface Account extends AccountInfo {
  createdAt: string
  /** When an admin disabled it, null while it may log in */
  disabledAt: string | null
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
  sessions: number
}

/** Names of the plugin's tables, from `ctx.table()` */
export type TableNames = (name: 'accounts' | 'identities' | 'sessions') => string

export const migrations: Record<string, PluginMigration> = {
  '001_init': {
    async up(db, { table }) {
      await db.schema.createTable(table('accounts'))
        .addColumn('id', 'varchar(36)', c => c.primaryKey())
        .addColumn('name', 'varchar(64)', c => c.notNull())
        .addColumn('created_at', 'varchar(32)', c => c.notNull())
        .addColumn('disabled_at', 'varchar(32)')
        .execute()

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
}

/** sha256 of a session token: what is stored and looked up, so a leaked database holds no usable tokens */
export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex')
}

function toAccount(row: Record<string, any>): Account {
  return { id: row.id, name: row.name, createdAt: row.created_at, disabledAt: row.disabled_at ?? null }
}

export default class AuthStore {
  constructor(readonly db: Kysely<any>, private readonly table: TableNames, private readonly now: () => Date = () => new Date()) {}

  /** Run `work` in a transaction where the database has them, with a store on it */
  transaction<T>(work: (store: AuthStore) => Promise<T>): Promise<T> {
    return this.db.transaction().execute(trx => work(new AuthStore(trx, this.table, this.now)))
  }

  async createAccount(name: string): Promise<Account> {
    const account = { id: randomUUID(), name, created_at: this.now().toISOString(), disabled_at: null }
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

  /** Disable or enable it again. Returns whether there is such an account */
  async setDisabled(id: string, disabled: boolean): Promise<boolean> {
    const result = await this.db.updateTable(this.table('accounts'))
      .set({ disabled_at: disabled ? this.now().toISOString() : null })
      .where('id', '=', id)
      .executeTakeFirst()
    return Number(result.numUpdatedRows) > 0
  }

  async identity(provider: string, externalId: string): Promise<IdentityRow | undefined> {
    const row = await this.db.selectFrom(this.table('identities'))
      .select(['provider', 'external_id', 'account_id', 'secret'])
      .where('provider', '=', provider)
      .where('external_id', '=', externalId)
      .executeTakeFirst()
    return row && { provider: row.provider, externalId: row.external_id, accountId: row.account_id, secret: row.secret ?? null }
  }

  /** The provider's identity of an account, e.g. its username for `password` */
  async identityOf(accountId: string, provider: string): Promise<IdentityRow | undefined> {
    const row = await this.db.selectFrom(this.table('identities'))
      .select(['provider', 'external_id', 'account_id', 'secret'])
      .where('account_id', '=', accountId)
      .where('provider', '=', provider)
      .executeTakeFirst()
    return row && { provider: row.provider, externalId: row.external_id, accountId: row.account_id, secret: row.secret ?? null }
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
    return { token, expiresAt }
  }

  /**
   * The account a token is logged in as, while its session hasn't run out, and the session moved on by `lifetimeMs`
   * from now. Undefined for an unknown or expired token. Disabled accounts are returned too: the caller says why it refuses
   */
  async useSession(token: string, lifetimeMs: number): Promise<Account | undefined> {
    const hash = hashToken(token)
    const now = this.now()
    const row = await this.db.selectFrom(`${this.table('sessions')} as s`)
      .innerJoin(`${this.table('accounts')} as a`, 'a.id', 's.account_id')
      .select(['a.id', 'a.name', 'a.created_at', 'a.disabled_at', 's.expires_at'])
      .where('s.token_hash', '=', hash)
      .executeTakeFirst()
    if (!row)
      return undefined

    if (row.expires_at <= now.toISOString()) {
      await this.deleteSession(token)
      return undefined
    }

    await this.db.updateTable(this.table('sessions'))
      .set({ last_seen_at: now.toISOString(), expires_at: new Date(now.getTime() + lifetimeMs).toISOString() })
      .where('token_hash', '=', hash)
      .execute()
    return toAccount(row)
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

  /** A page of accounts, newest first, with how they log in and how many sessions they have */
  async listAccounts(limit: number, offset: number): Promise<{ accounts: AccountListing[], total: number }> {
    const rows = await this.db.selectFrom(this.table('accounts')).selectAll().orderBy('created_at', 'desc').orderBy('id').limit(limit).offset(offset).execute()
    const total = await this.db.selectFrom(this.table('accounts')).select(eb => eb.fn.countAll().as('count')).executeTakeFirstOrThrow()
    const ids = rows.map(row => row.id as string)
    if (ids.length === 0)
      return { accounts: [], total: Number(total.count) }

    const identities = await this.db.selectFrom(this.table('identities')).select(['account_id', 'provider']).where('account_id', 'in', ids).execute()
    const sessions = await this.db.selectFrom(this.table('sessions'))
      .select(['account_id', eb => eb.fn.countAll().as('count')])
      .where('account_id', 'in', ids)
      .where('expires_at', '>', this.now().toISOString())
      .groupBy('account_id')
      .execute()

    return {
      total: Number(total.count),
      accounts: rows.map(row => ({
        ...toAccount(row),
        providers: identities.filter(identity => identity.account_id === row.id).map(identity => identity.provider as string).sort(),
        sessions: Number(sessions.find(session => session.account_id === row.id)?.count ?? 0),
      })),
    }
  }
}
