import { runPluginMigrations } from '@mavonengine/core/Plugins/Database/migrate'
import { tableName } from '@mavonengine/core/Plugins/Database/tables'
import { beforeEach, describe, expect, it } from 'vitest'
import AuthStore, { hashToken, migrations } from '../src/store'
import { memoryDb } from './memoryDb'

const PKG = '@mavonengine/auth'
const DAY = 24 * 60 * 60 * 1000

let now: Date
let store: AuthStore

beforeEach(async () => {
  const db = memoryDb()
  await runPluginMigrations(db, PKG, migrations)
  now = new Date('2026-11-15T12:00:00.000Z')
  store = new AuthStore(db, name => tableName(PKG, name), () => now)
})

describe('auth store', () => {
  it('names its tables after the plugin', () => {
    expect(tableName(PKG, 'accounts')).toBe('auth_accounts')
  })

  it('keeps only the hash of a session token, and finds the account by the token', async () => {
    const account = await store.createAccount('Ada')
    const { token, expiresAt } = await store.createSession(account.id, 30 * DAY)

    expect(token).toMatch(/^[\w-]{43}$/)
    expect(expiresAt).toBe('2026-12-15T12:00:00.000Z')
    const rows = await store.db.selectFrom('auth_sessions').selectAll().execute()
    expect(rows).toHaveLength(1)
    expect(rows[0].token_hash).toBe(hashToken(token))
    expect(JSON.stringify(rows)).not.toContain(token)

    expect((await store.useSession(token, 30 * DAY))?.name).toBe('Ada')
    expect(await store.useSession('not-a-token', 30 * DAY)).toBeUndefined()
  })

  it('moves a session on when it is used, and forgets it once it ran out', async () => {
    const account = await store.createAccount('Ada')
    const { token } = await store.createSession(account.id, 10 * DAY)

    now = new Date(now.getTime() + 9 * DAY)
    expect(await store.useSession(token, 10 * DAY)).toBeDefined()
    // 9 days after the last use, not 18 after it was made
    now = new Date(now.getTime() + 9 * DAY)
    expect(await store.useSession(token, 10 * DAY)).toBeDefined()

    now = new Date(now.getTime() + 11 * DAY)
    expect(await store.useSession(token, 10 * DAY)).toBeUndefined()
    expect(await store.db.selectFrom('auth_sessions').selectAll().execute()).toHaveLength(0)
  })

  it('ends an account\'s sessions, all or all but one', async () => {
    const ada = await store.createAccount('Ada')
    const bob = await store.createAccount('Bob')
    const keep = await store.createSession(ada.id, DAY)
    await store.createSession(ada.id, DAY)
    await store.createSession(ada.id, DAY)
    const bobs = await store.createSession(bob.id, DAY)

    expect(await store.deleteSessionsOf(ada.id, keep.token)).toBe(2)
    expect(await store.useSession(keep.token, DAY)).toBeDefined()
    expect(await store.deleteSessionsOf(ada.id)).toBe(1)
    expect(await store.useSession(bobs.token, DAY)).toBeDefined()
  })

  it('forgets expired sessions in one go', async () => {
    const ada = await store.createAccount('Ada')
    await store.createSession(ada.id, DAY)
    await store.createSession(ada.id, 3 * DAY)
    now = new Date(now.getTime() + 2 * DAY)

    expect(await store.deleteExpiredSessions()).toBe(1)
  })

  it('links several providers to one account, each provider user to one account', async () => {
    const ada = await store.createAccount('Ada')
    await store.addIdentity({
      provider: 'password',
      externalId: 'ada',
      accountId: ada.id,
      secret: 'hash',
    })
    await store.addIdentity({
      provider: 'discord',
      externalId: '123',
      accountId: ada.id,
      secret: null,
    })

    expect((await store.identity('discord', '123'))?.accountId).toBe(ada.id)
    expect((await store.identityOf(ada.id, 'password'))?.secret).toBe('hash')
    expect(await store.identity('github', '123')).toBeUndefined()

    const bob = await store.createAccount('Bob')
    await expect(store.addIdentity({
      provider: 'discord',
      externalId: '123',
      accountId: bob.id,
      secret: null,
    })).rejects.toThrow()
  })

  it('lists accounts with how they log in and their live sessions', async () => {
    const ada = await store.createAccount('Ada')
    now = new Date(now.getTime() + 1000)
    const bob = await store.createAccount('Bob')
    await store.addIdentity({
      provider: 'password',
      externalId: 'ada',
      accountId: ada.id,
      secret: 'x',
    })
    await store.addIdentity({
      provider: 'discord',
      externalId: '1',
      accountId: ada.id,
      secret: null,
    })
    await store.createSession(ada.id, DAY)
    await store.setDisabled(bob.id, true)

    const { accounts, total } = await store.listAccounts(10, 0)
    expect(total).toBe(2)
    expect(accounts.map(a => [
      a.name,
      a.providers,
      a.sessions,
      !!a.disabledAt,
    ])).toEqual([
      ['Bob', [], 0, true],
      [
        'Ada',
        ['discord', 'password'],
        1,
        false,
      ],
    ])
    expect((await store.listAccounts(1, 1)).accounts.map(a => a.name)).toEqual(['Ada'])
    expect(await store.setDisabled('nobody', true)).toBe(false)
  })

  it('searches accounts by name, email, username or id, and filters guests and disabled ones', async () => {
    const ada = await store.createAccount('Ada Lovelace', { email: 'Ada@Example.com' })
    await store.addIdentity({
      provider: 'password',
      externalId: 'countess_1',
      accountId: ada.id,
      secret: 'x',
    })
    const bob = await store.createAccount('Bob')
    await store.setDisabled(bob.id, true)
    const guest = await store.createAccount('Guest-1', { guest: true })
    await store.createSession(guest.id, DAY)

    const names = async (query: Parameters<AuthStore['listAccounts']>[2]) => (await store.listAccounts(10, 0, query)).accounts.map(a => a.name).sort()
    expect(await names({ search: 'lovelace' })).toEqual(['Ada Lovelace'])
    expect(await names({ search: 'example.COM' })).toEqual(['Ada Lovelace'])
    expect(await names({ search: 'countess_' })).toEqual(['Ada Lovelace'])
    expect(await names({ search: bob.id })).toEqual(['Bob'])
    // LIKE's wildcards are taken as text
    expect(await names({ search: '%' })).toEqual([])
    expect(await names({ search: '_' })).toEqual(['Ada Lovelace'])
    expect(await names({ filter: 'guests' })).toEqual(['Guest-1'])
    expect(await names({ filter: 'disabled' })).toEqual(['Bob'])
    expect(await names({ filter: 'disabled', search: 'ada' })).toEqual([])
    expect((await store.listAccounts(10, 0, { search: 'ada' })).total).toBe(1)

    const [listed] = (await store.listAccounts(10, 0, { search: 'ada' })).accounts
    expect(listed.username).toBe('countess_1')
    expect(await store.stats()).toEqual({
      accounts: 3,
      guests: 1,
      disabled: 1,
      sessions: 1,
    })
  })

  it('makes guest accounts and turns them into full ones with the same id', async () => {
    const guest = await store.createAccount('Guest-1234', { guest: true })
    expect(guest.guest).toBe(true)
    expect((await store.account(guest.id))?.guest).toBe(true)

    await store.upgradeGuest(guest.id, 'Ada')
    expect(await store.account(guest.id)).toMatchObject({ id: guest.id, name: 'Ada', guest: false })
    expect((await store.createAccount('Bob')).guest).toBe(false)
  })

  it('gives a guest session its own lifetime', async () => {
    const guest = await store.createAccount('Guest-1', { guest: true })
    const { token } = await store.createSession(guest.id, DAY)
    const lifetime = (account: { guest: boolean }) => account.guest
      ? 2 * DAY
      : 30 * DAY

    await store.useSession(token, lifetime)
    const [row] = await store.db.selectFrom('auth_sessions').select('expires_at').execute()
    expect(row.expires_at).toBe('2026-11-17T12:00:00.000Z')
  })

  it('deletes guest accounts without a session that works, and nothing else', async () => {
    const live = await store.createAccount('Guest-1', { guest: true })
    await store.createSession(live.id, 10 * DAY)
    const expired = await store.createAccount('Guest-2', { guest: true })
    await store.createSession(expired.id, DAY)
    const loggedOut = await store.createAccount('Guest-3', { guest: true })
    const ada = await store.createAccount('Ada')

    now = new Date(now.getTime() + 2 * DAY)
    expect(await store.deleteAbandonedGuests()).toBe(2)

    expect(await store.account(live.id)).toBeDefined()
    expect(await store.account(expired.id)).toBeUndefined()
    expect(await store.account(loggedOut.id)).toBeUndefined()
    expect(await store.account(ada.id)).toBeDefined()
    expect(await store.db.selectFrom('auth_sessions').select('account_id').execute()).toEqual([
      { account_id: live.id },
    ])
  })

  it('keeps one email per account regardless of case, and accounts without one', async () => {
    const ada = await store.createAccount('Ada', { email: 'Ada@Example.com' })
    await store.createAccount('Bob')
    await store.createAccount('Cy')

    expect(ada.email).toBe('Ada@Example.com')
    expect(await store.emailTaken('ada@example.COM')).toBe(true)
    expect(await store.emailTaken('ada@example.com', ada.id)).toBe(false)
    await expect(store.createAccount('Eve', { email: 'ADA@example.com' })).rejects.toThrow()

    await store.setEmail(ada.id, null)
    expect(await store.emailTaken('ada@example.com')).toBe(false)
  })

  it('remembers when the account last got a session', async () => {
    const ada = await store.createAccount('Ada')
    expect(ada.lastLoginAt).toBeNull()

    await store.createSession(ada.id, DAY)
    expect((await store.account(ada.id))?.lastLoginAt).toBe('2026-11-15T12:00:00.000Z')
  })

  it('rolls a transaction back when it throws', async () => {
    await expect(store.transaction(async (tx) => {
      await tx.createAccount('Ada')
      throw new Error('stop')
    })).rejects.toThrow('stop')

    expect((await store.listAccounts(10, 0)).total).toBe(0)
  })
})

describe('auth store tokens', () => {
  const HOUR = 60 * 60 * 1000

  it('keeps only the hash of a token, which works once, until it runs out', async () => {
    const account = await store.createAccount('Ada', { email: 'ada@example.com' })
    const token = await store.createToken(account.id, 'verify-email', 'ada@example.com', HOUR)
    expect(token).toMatch(/^[\w-]{43}$/)
    expect(await store.db.selectFrom('auth_tokens').select('token_hash').execute()).toEqual([
      {
        token_hash: hashToken(token),
      },
    ])

    // For one purpose only
    expect(await store.token(token, 'reset-password')).toBeUndefined()
    expect(await store.token(token, 'verify-email')).toMatchObject({ accountId: account.id, email: 'ada@example.com' })

    now = new Date(now.getTime() + HOUR)
    expect(await store.useToken(token, 'verify-email')).toBeUndefined()
    expect(await store.deleteExpiredTokens()).toBe(1)
  })

  it('works once, and only the latest of a purpose', async () => {
    const account = await store.createAccount('Ada', { email: 'ada@example.com' })
    const first = await store.createToken(account.id, 'reset-password', 'ada@example.com', HOUR)
    const verify = await store.createToken(account.id, 'verify-email', 'ada@example.com', HOUR)
    const second = await store.createToken(account.id, 'reset-password', 'ada@example.com', HOUR)

    expect(await store.useToken(first, 'reset-password')).toBeUndefined()
    expect(await store.useToken(second, 'reset-password')).toMatchObject({ accountId: account.id })
    expect(await store.useToken(second, 'reset-password')).toBeUndefined()
    // Another purpose's is left alone
    expect(await store.token(verify, 'verify-email')).toBeDefined()
  })

  it('confirms an email only while the account still has it, in any case', async () => {
    const account = await store.createAccount('Ada', { email: 'Ada@Example.com' })
    expect(await store.markEmailVerified(account.id, 'other@example.com')).toBe(false)
    expect(await store.markEmailVerified(account.id, 'ada@example.com')).toBe(true)
    expect((await store.account(account.id))!.emailVerifiedAt).toBe(now.toISOString())
    expect((await store.accountByEmail('ADA@example.COM'))!.id).toBe(account.id)
  })
})
