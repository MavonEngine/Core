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
    await store.addIdentity({ provider: 'password', externalId: 'ada', accountId: ada.id, secret: 'hash' })
    await store.addIdentity({ provider: 'discord', externalId: '123', accountId: ada.id, secret: null })

    expect((await store.identity('discord', '123'))?.accountId).toBe(ada.id)
    expect((await store.identityOf(ada.id, 'password'))?.secret).toBe('hash')
    expect(await store.identity('github', '123')).toBeUndefined()

    const bob = await store.createAccount('Bob')
    await expect(store.addIdentity({ provider: 'discord', externalId: '123', accountId: bob.id, secret: null })).rejects.toThrow()
  })

  it('lists accounts with how they log in and their live sessions', async () => {
    const ada = await store.createAccount('Ada')
    now = new Date(now.getTime() + 1000)
    const bob = await store.createAccount('Bob')
    await store.addIdentity({ provider: 'password', externalId: 'ada', accountId: ada.id, secret: 'x' })
    await store.addIdentity({ provider: 'discord', externalId: '1', accountId: ada.id, secret: null })
    await store.createSession(ada.id, DAY)
    await store.setDisabled(bob.id, true)

    const { accounts, total } = await store.listAccounts(10, 0)
    expect(total).toBe(2)
    expect(accounts.map(a => [a.name, a.providers, a.sessions, !!a.disabledAt])).toEqual([
      ['Bob', [], 0, true],
      ['Ada', ['discord', 'password'], 1, false],
    ])
    expect((await store.listAccounts(1, 1)).accounts.map(a => a.name)).toEqual(['Ada'])
    expect(await store.setDisabled('nobody', true)).toBe(false)
  })

  it('rolls a transaction back when it throws', async () => {
    await expect(store.transaction(async (tx) => {
      await tx.createAccount('Ada')
      throw new Error('stop')
    })).rejects.toThrow('stop')

    expect((await store.listAccounts(10, 0)).total).toBe(0)
  })
})
