import type { ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { RequestHandler } from 'express'
import type { AddressInfo } from 'node:net'
import { identityOf } from '@mavonengine/core/Networking/identity'
import { runPluginMigrations } from '@mavonengine/core/Plugins/Database/migrate'
import { tableName } from '@mavonengine/core/Plugins/Database/tables'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import plugin, { auth, AuthError, parseOptions } from '../src/server'
import { memoryDb } from './memoryDb'

const PKG = '@mavonengine/auth'
/** Which session a connection was made with: a piece of the token's hash, never the token */
const SESSION = expect.stringMatching(/^[0-9a-f]{16}$/)

const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.headers.authorization !== 'Bearer admin-token') {
    res.status(401).json({ error: 'admin only' })
    return
  }
  next()
}

const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
  vi.unstubAllEnvs()
})

/** The plugin set up on a server of its own: a database, its routes on a real HTTP port */
async function started(options: Record<string, unknown> = {}, { database = true } = {}) {
  const db = database
    ? memoryDb()
    : undefined
  if (db)
    await runPluginMigrations(db, PKG, plugin.migrations)

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const ctx = {
    package: PKG,
    options,
    server: {},
    logger,
    db,
    requireAdmin,
    table: (name: string) => tableName(PKG, name),
    identity: identityOf,
  } as unknown as ServerPluginContext

  await plugin.setup(ctx)
  const app = express()
  plugin.http(app, ctx)
  const listening = app.listen(0)
  await new Promise(resolve => listening.once('listening', resolve))
  const base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}/api/auth`
  closers.push(async () => {
    plugin.destroy(ctx)
    await new Promise(resolve => listening.close(resolve))
  })

  async function request(method: string, path: string, { body, token }: { body?: unknown, token?: string } = {}) {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (token)
      headers.Authorization = `Bearer ${token}`
    const res = await fetch(`${base}${path}`, {
      method,
      headers,
      body: body === undefined
        ? undefined
        : JSON.stringify(body),
    })
    const text = await res.text()
    return {
      status: res.status,
      headers: res.headers,
      json: text
        ? JSON.parse(text)
        : undefined,
    }
  }

  const authorize = (header?: string) => plugin.authorize(header, {}, ctx)

  /** A game connection of `identity`, as core hands it to the plugin */
  function connect(identity: unknown) {
    const channel = {
      id: Math.random().toString(36),
      userData: identity,
      close: vi.fn(async () => {}),
    }
    plugin.onConnection(channel as any, {}, ctx)
    return channel
  }

  return {
    ctx,
    logger,
    request,
    authorize,
    connect,
    hooks: auth(ctx.server),
  }
}

async function registered(server: Awaited<ReturnType<typeof started>>, username = 'Ada', password = 'correct horse') {
  const res = await server.request('POST', '/register', {
    body: { username, password },
  })
  expect(res.status).toBe(201)
  return res.json as { token: string, account: { id: string, name: string, email?: string | null } }
}

describe('auth plugin', () => {
  it('gives other plugins its hooks as its api, with the account\'s email', async () => {
    const server = await started()
    const res = await server.request('POST', '/register', {
      body: { username: 'Ada', password: 'correct horse', email: 'ada@example.com' },
    })
    const id = (res.json as { account: { id: string } }).account.id

    const api = plugin.api(server.ctx)
    expect(api).toBe(server.hooks)
    expect(await api.account(id)).toMatchObject({ email: 'ada@example.com', emailVerifiedAt: null })
  })

  it('registers a player, logged in, with a session the game connection accepts', async () => {
    const server = await started()
    const { token, account } = await registered(server)

    expect(account.name).toBe('Ada')
    expect(await server.authorize(`Bearer ${token}`)).toEqual({ id: account.id, name: 'Ada', session: SESSION })
    expect((await server.request('GET', '/me', { token })).json).toEqual({ account })
  })

  describe('email', () => {
    it('is optional, kept with the account and shown to the player, never in the game\'s identity', async () => {
      const server = await started()
      const res = await server.request('POST', '/register', {
        body: { username: 'Ada', password: 'correct horse', email: '  Ada@Example.com ' },
      })

      expect(res.status).toBe(201)
      expect(res.json.account.email).toBe('Ada@Example.com')
      expect((await server.request('GET', '/me', { token: res.json.token })).json.account.email).toBe('Ada@Example.com')
      expect(await server.authorize(`Bearer ${res.json.token}`)).not.toHaveProperty('email')

      // Without one
      expect((await registered(server, 'Bob')).account.email).toBeNull()
    })

    it('is unique regardless of case', async () => {
      const server = await started()
      await server.request('POST', '/register', {
        body: { username: 'Ada', password: 'correct horse', email: 'ada@example.com' },
      })

      const taken = await server.request('POST', '/register', {
        body: { username: 'Bob', password: 'correct horse', email: 'ADA@example.COM' },
      })
      expect(taken.status).toBe(409)
      expect(taken.json.error).toBe('That email is in use')
      // The name wasn't taken by the failed registration
      expect((await server.request('POST', '/register', {
        body: { username: 'Bob', password: 'correct horse' },
      })).status).toBe(201)
    })

    it('must look like an email address', async () => {
      const server = await started()
      for (const email of [
        'ada',
        'ada@',
        '@example.com',
        'a b@example.com',
        `${'a'.repeat(250)}@x.io`,
        42,
      ]) {
        const res = await server.request('POST', '/register', {
          body: { username: 'Ada', password: 'correct horse', email },
        })
        expect(res.status, String(email)).toBe(400)
      }
    })

    it('is given to a guest that registers with one', async () => {
      const server = await started({ guests: true })
      const guest = (await server.request('POST', '/guest')).json

      const res = await server.request('POST', '/register', {
        token: guest.token,
        body: { username: 'Ada', password: 'correct horse', email: 'ada@example.com' },
      })
      expect(res.json.account).toEqual({
        id: guest.account.id,
        name: 'Ada',
        email: 'ada@example.com',
        emailVerified: false,
      })
    })

    it('comes from a login plugin\'s profile, when no other account has it', async () => {
      const server = await started()
      const first = await server.hooks.signIn('discord', '1', { name: 'ada', email: 'ada@example.com', emailVerified: true })
      expect(first.account.email).toBe('ada@example.com')
      expect((await server.hooks.account(first.account.id))?.emailVerifiedAt).toEqual(expect.any(String))

      // Taken, or no email at all: the login still works, without one
      expect((await server.hooks.signIn('github', '2', { name: 'other', email: 'ADA@example.com' })).account.email).toBeNull()
      expect((await server.hooks.signIn('github', '3', { name: 'odd', email: 'not an email' })).account.email).toBeNull()
    })

    it('is shown to admins with when the account last logged in', async () => {
      const server = await started()
      await server.request('POST', '/register', {
        body: { username: 'Ada', password: 'correct horse', email: 'ada@example.com' },
      })

      const [account] = (await server.request('GET', '/accounts', { token: 'admin-token' })).json.accounts
      expect(account).toMatchObject({
        email: 'ada@example.com',
        emailVerifiedAt: null,
        lastLoginAt: expect.any(String),
      })
      expect(account).not.toHaveProperty('email_key')
    })
  })

  it('turns away a connection without a working session', async () => {
    const server = await started()

    expect(await server.authorize(undefined)).toBe(false)
    expect(await server.authorize('Bearer nope')).toBe(401)
    expect(await server.authorize('Basic abc')).toBe(false)
    expect((await server.request('GET', '/me')).status).toBe(401)
  })

  it('checks usernames and passwords, and keeps names unique regardless of case', async () => {
    const server = await started()
    await registered(server, 'Ada')

    expect((await server.request('POST', '/register', {
      body: { username: 'ADA', password: 'another one' },
    })).status).toBe(409)
    expect((await server.request('POST', '/register', {
      body: { username: 'a', password: 'long enough' },
    })).json.error).toMatch(/3 to 32/)
    expect((await server.request('POST', '/register', {
      body: { username: 'bob', password: 'short' },
    })).json.error).toMatch(/at least 8/)
    expect((await server.request('POST', '/register', {
      body: {
        username: 'bob',
        password: 'x'.repeat(257),
      },
    })).status).toBe(400)
    expect((await server.request('POST', '/register', { body: '[]' })).status).toBe(400)
  })

  it('logs in by username in any case, with one answer for a wrong name or password', async () => {
    const server = await started()
    const { account } = await registered(server, 'Ada', 'correct horse')

    const login = await server.request('POST', '/login', {
      body: { username: 'ada', password: 'correct horse' },
    })
    expect(login.status).toBe(200)
    expect(login.json.account).toEqual(account)

    const wrongPassword = await server.request('POST', '/login', {
      body: { username: 'Ada', password: 'wrong horse' },
    })
    const wrongName = await server.request('POST', '/login', {
      body: { username: 'Nobody', password: 'correct horse' },
    })
    expect([wrongPassword.status, wrongName.status]).toEqual([401, 401])
    expect(wrongPassword.json).toEqual(wrongName.json)
  })

  it('refuses logins for a while after too many failed tries for one name', async () => {
    const server = await started({ loginAttempts: 3, loginWindowMinutes: 5 })
    await registered(server, 'Ada', 'correct horse')

    for (let i = 0; i < 3; i++) {
      expect((await server.request('POST', '/login', {
        body: { username: 'Ada', password: 'guess' },
      })).status).toBe(401)
    }

    const blocked = await server.request('POST', '/login', {
      body: { username: 'Ada', password: 'correct horse' },
    })
    expect(blocked.status).toBe(429)
    expect(Number(blocked.headers.get('retry-after'))).toBeGreaterThan(0)
    // Another name from the same address isn't held up
    await registered(server, 'Bob')
    expect((await server.request('POST', '/login', {
      body: { username: 'Bob', password: 'correct horse' },
    })).status).toBe(200)
  })

  it('ends the session on logout', async () => {
    const server = await started()
    const { token } = await registered(server)

    expect((await server.request('POST', '/logout', { token })).status).toBe(204)
    expect(await server.authorize(`Bearer ${token}`)).toBe(401)
    expect((await server.request('POST', '/logout')).status).toBe(204)
  })

  it('tells sessions apart, without the token in the identity', async () => {
    const server = await started()
    const { token } = await registered(server)
    const other = (await server.request('POST', '/login', {
      body: { username: 'Ada', password: 'correct horse' },
    })).json.token

    const here = await server.authorize(`Bearer ${token}`) as Record<string, unknown>
    const there = await server.authorize(`Bearer ${other}`) as Record<string, unknown>
    expect(here.session).not.toBe(there.session)
    expect(JSON.stringify(here)).not.toContain(token)
  })

  it('closes the game connections of a session that logs out, and only those', async () => {
    const server = await started()
    const { token } = await registered(server)
    const phone = (await server.request('POST', '/login', {
      body: { username: 'Ada', password: 'correct horse' },
    })).json.token
    const here = server.connect(await server.authorize(`Bearer ${token}`))
    const onPhone = server.connect(await server.authorize(`Bearer ${phone}`))

    expect((await server.request('POST', '/logout', { token })).status).toBe(204)

    expect(here.close).toHaveBeenCalled()
    expect(onPhone.close).not.toHaveBeenCalled()
  })

  it('closes the game connections of the sessions a password change ends, not this one\'s', async () => {
    const server = await started()
    const { token } = await registered(server, 'Ada', 'correct horse')
    const elsewhere = (await server.request('POST', '/login', {
      body: { username: 'Ada', password: 'correct horse' },
    })).json.token
    const here = server.connect(await server.authorize(`Bearer ${token}`))
    const there = server.connect(await server.authorize(`Bearer ${elsewhere}`))

    await server.request('POST', '/password', {
      token,
      body: { current: 'correct horse', password: 'battery staple' },
    })

    expect(there.close).toHaveBeenCalled()
    expect(here.close).not.toHaveBeenCalled()
  })

  it('changes the password and logs out everywhere else', async () => {
    const server = await started()
    const { token } = await registered(server, 'Ada', 'correct horse')
    const elsewhere = (await server.request('POST', '/login', {
      body: { username: 'Ada', password: 'correct horse' },
    })).json.token

    expect((await server.request('POST', '/password', {
      token,
      body: { current: 'wrong', password: 'battery staple' },
    })).status).toBe(401)
    expect((await server.request('POST', '/password', {
      token,
      body: { current: 'correct horse', password: 'battery staple' },
    })).status).toBe(204)

    expect(await server.authorize(`Bearer ${elsewhere}`)).toBe(401)
    expect(await server.authorize(`Bearer ${token}`)).toMatchObject({ name: 'Ada' })
    expect((await server.request('POST', '/login', {
      body: { username: 'Ada', password: 'correct horse' },
    })).status).toBe(401)
    expect((await server.request('POST', '/login', {
      body: { username: 'Ada', password: 'battery staple' },
    })).status).toBe(200)
  })

  it('lets an admin disable an account, which closes its game connections and ends its sessions', async () => {
    const server = await started()
    const { token, account } = await registered(server)
    const bob = await registered(server, 'Bob')
    const adas = server.connect({ id: account.id, name: 'Ada' })
    const bobs = server.connect({ id: bob.account.id, name: 'Bob' })

    expect((await server.request('POST', `/accounts/${account.id}/disable`)).status).toBe(401)
    expect((await server.request('POST', `/accounts/${account.id}/disable`, { token: 'admin-token' })).json).toEqual({ disabled: true })

    expect(adas.close).toHaveBeenCalled()
    expect(bobs.close).not.toHaveBeenCalled()
    expect(await server.authorize(`Bearer ${token}`)).toBe(401)
    expect((await server.request('POST', '/login', {
      body: { username: 'Ada', password: 'correct horse' },
    })).status).toBe(403)

    expect((await server.request('POST', `/accounts/${account.id}/enable`, { token: 'admin-token' })).json).toEqual({ disabled: false })
    expect((await server.request('POST', '/login', {
      body: { username: 'Ada', password: 'correct horse' },
    })).status).toBe(200)
    expect((await server.request('POST', '/accounts/nobody/disable', { token: 'admin-token' })).status).toBe(404)
  })

  it('lists accounts and logs one out everywhere for an admin', async () => {
    const server = await started()
    const { account } = await registered(server)
    const connection = server.connect({ id: account.id, name: 'Ada' })

    const list = await server.request('GET', '/accounts?limit=10', { token: 'admin-token' })
    expect(list.json.total).toBe(1)
    expect(list.json.accounts[0]).toMatchObject({
      id: account.id,
      name: 'Ada',
      providers: ['password'],
      sessions: 1,
    })
    expect(JSON.stringify(list.json)).not.toContain('scrypt')

    expect((await server.request('DELETE', `/accounts/${account.id}/sessions`, { token: 'admin-token' })).json).toEqual({ ended: 1 })
    expect(connection.close).toHaveBeenCalled()
  })

  it('stops tracking a connection once it closed', async () => {
    const server = await started()
    const { account } = await registered(server)
    const connection = server.connect({ id: account.id, name: 'Ada' })
    plugin.onDisconnect(connection as any, server.ctx)

    await server.hooks.endSessions(account.id)
    expect(connection.close).not.toHaveBeenCalled()
  })

  it('lets guests in without a session only when asked to, and never in production', async () => {
    const strict = await started()
    expect(await strict.authorize(undefined)).toBe(false)

    const guests = await started({ devGuests: true })
    expect(await guests.authorize(undefined)).toBe(true)
    // A token that doesn't work is still refused: only no token at all is a guest
    expect(await guests.authorize('Bearer nope')).toBe(401)

    vi.stubEnv('NODE_ENV', 'production')
    expect(await guests.authorize(undefined)).toBe(false)
  })

  it('can turn registration off', async () => {
    const server = await started({ registration: false })
    expect((await server.request('POST', '/register', {
      body: { username: 'Ada', password: 'correct horse' },
    })).status).toBe(403)
  })

  it('turns every client away without a database, and says why', async () => {
    const server = await started({}, { database: false })

    expect(server.logger.error).toHaveBeenCalledWith(expect.stringContaining('no database'))
    expect(await server.authorize('Bearer anything')).toBe(503)
    expect((await server.request('POST', '/login', {
      body: { username: 'Ada', password: 'correct horse' },
    })).status).toBe(503)
    await expect(server.hooks.signIn('discord', '1')).rejects.toMatchObject({ status: 503 })
  })

  describe('guests', () => {
    const asGuest = async (server: Awaited<ReturnType<typeof started>>) => {
      const res = await server.request('POST', '/guest')
      expect(res.status).toBe(201)
      return res.json as { token: string, account: { id: string, name: string, guest?: true }, expiresAt: string }
    }

    it('are off unless the options turn them on', async () => {
      const server = await started()
      expect((await server.request('POST', '/guest')).status).toBe(403)
    })

    it('get an account of their own and connect as it, marked as guests', async () => {
      const server = await started({ guests: true })
      const guest = await asGuest(server)

      expect(guest.account.name).toMatch(/^Guest-\d{4}$/)
      expect(guest.account.guest).toBe(true)
      expect(await server.authorize(`Bearer ${guest.token}`)).toEqual({
        id: guest.account.id,
        name: guest.account.name,
        guest: true,
        session: SESSION,
      })
      expect((await server.request('GET', '/me', { token: guest.token })).json.account.guest).toBe(true)
      // A registered player has no guest flag at all
      const { token } = await registered(server)
      expect(await server.authorize(`Bearer ${token}`)).not.toHaveProperty('guest')
    })

    it('keep their account when they register, so the game keeps their progress', async () => {
      const server = await started({ guests: true })
      const guest = await asGuest(server)

      const res = await server.request('POST', '/register', {
        token: guest.token,
        body: { username: 'Ada', password: 'correct horse' },
      })
      expect(res.status).toBe(201)
      expect(res.json.account).toEqual({
        id: guest.account.id,
        name: 'Ada',
        email: null,
        emailVerified: false,
      })
      // Both the new session and the guest's own now connect as the full account
      expect(await server.authorize(`Bearer ${res.json.token}`)).toEqual({ id: guest.account.id, name: 'Ada', session: SESSION })
      expect(await server.authorize(`Bearer ${guest.token}`)).toEqual({ id: guest.account.id, name: 'Ada', session: SESSION })
      expect((await server.request('POST', '/login', {
        body: { username: 'ada', password: 'correct horse' },
      })).json.account.id).toBe(guest.account.id)
    })

    it('stay guests when the name they register is taken', async () => {
      const server = await started({ guests: true })
      await registered(server, 'Ada')
      const guest = await asGuest(server)

      expect((await server.request('POST', '/register', {
        token: guest.token,
        body: { username: 'ADA', password: 'correct horse' },
      })).status).toBe(409)
      expect(await server.authorize(`Bearer ${guest.token}`)).toMatchObject({ guest: true })
    })

    it('don\'t turn a registered player\'s account into another one', async () => {
      const server = await started({ guests: true })
      const ada = await registered(server, 'Ada')

      const bob = await server.request('POST', '/register', {
        token: ada.token,
        body: { username: 'Bob', password: 'correct horse' },
      })
      expect(bob.json.account.id).not.toBe(ada.account.id)
    })

    it('keep their account when they link a login of another provider', async () => {
      const server = await started({ guests: true })
      const guest = await asGuest(server)

      const linked = await server.hooks.signIn('discord', '123', { name: 'ada_discord' }, { linkTo: guest.account.id })
      expect(linked.account).toEqual({
        id: guest.account.id,
        name: 'ada_discord',
        email: null,
        emailVerified: false,
      })
      expect((await server.hooks.signIn('discord', '123')).account.id).toBe(guest.account.id)
    })

    it('have sessions as long as guestDays, and lose their account when they log out', async () => {
      const server = await started({ guests: true, guestDays: 2 })
      const guest = await asGuest(server)

      const days = (Date.parse(guest.expiresAt) - Date.now()) / (24 * 60 * 60 * 1000)
      expect(days).toBeGreaterThan(1.9)
      expect(days).toBeLessThan(2.1)

      expect((await server.request('POST', '/logout', { token: guest.token })).status).toBe(204)
      expect(await server.hooks.account(guest.account.id)).toBeUndefined()
    })

    it('are limited per address', async () => {
      const server = await started({ guests: true, guestsPerHour: 2 })
      await asGuest(server)
      await asGuest(server)

      const third = await server.request('POST', '/guest')
      expect(third.status).toBe(429)
      expect(Number(third.headers.get('retry-after'))).toBeGreaterThan(0)
    })

    it('show up as guests for an admin', async () => {
      const server = await started({ guests: true })
      await asGuest(server)

      const list = await server.request('GET', '/accounts', { token: 'admin-token' })
      expect(list.json.accounts[0]).toMatchObject({ guest: true, providers: [], sessions: 1 })
    })
  })

  describe('signIn() for login plugins', () => {
    it('makes an account for a provider user seen the first time, and logs the same one in after', async () => {
      const server = await started()

      const first = await server.hooks.signIn('discord', '123', { name: 'ada\u0000\n' })
      expect(first.account.name).toBe('ada')
      const again = await server.hooks.signIn('discord', '123', { name: 'renamed' })
      expect(again.account.id).toBe(first.account.id)
      expect(again.token).not.toBe(first.token)
      expect(await server.authorize(`Bearer ${again.token}`)).toEqual({ id: first.account.id, name: 'ada', session: SESSION })

      expect((await server.hooks.signIn('github', '9')).account.name).toBe('player')
    })

    it('links a provider user to an existing account, once', async () => {
      const server = await started()
      const { account } = await registered(server)
      const bob = await registered(server, 'Bob')

      const linked = await server.hooks.signIn('discord', '123', { name: 'ada_discord' }, { linkTo: account.id })
      expect(linked.account).toEqual(account)
      expect((await server.hooks.signIn('discord', '123')).account.id).toBe(account.id)

      await expect(server.hooks.signIn('discord', '123', {}, { linkTo: bob.account.id })).rejects.toMatchObject({ status: 409 })
      await expect(server.hooks.signIn('discord', '456', {}, { linkTo: 'nobody' })).rejects.toMatchObject({ status: 404 })
    })

    it('refuses disabled accounts and the password provider', async () => {
      const server = await started()
      const { account } = await server.hooks.signIn('discord', '123')
      await server.hooks.disable(account.id)

      await expect(server.hooks.signIn('discord', '123')).rejects.toBeInstanceOf(AuthError)
      await expect(server.hooks.signIn('discord', '123')).rejects.toMatchObject({ status: 403 })
      await expect(server.hooks.signIn('password', 'ada')).rejects.toMatchObject({ status: 400 })
    })
  })

  it('reads its options, falling back on what it can\'t use', () => {
    expect(parseOptions({
      path: '/auth/',
      sessionDays: 7,
      registration: false,
      devGuests: 'yes',
      loginAttempts: -1,
      guests: true,
      guestDays: 3,
    })).toMatchObject({
      path: '/auth',
      sessionDays: 7,
      registration: false,
      devGuests: false,
      loginAttempts: 10,
      guests: true,
      guestDays: 3,
      guestsPerHour: 20,
    })
    expect(parseOptions({}).guests).toBe(false)
  })
})
