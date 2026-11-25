import type { ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { AddressInfo } from 'node:net'
import type { MailInput } from '../src/mails'
import { identityOf } from '@mavonengine/core/Networking/identity'
import { runPluginMigrations } from '@mavonengine/core/Plugins/Database/migrate'
import { tableName } from '@mavonengine/core/Plugins/Database/tables'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import plugin, { MAILS_PER_ADDRESS_PER_HOUR, parseOptions } from '../src/server'
import { memoryDb } from './memoryDb'

const PKG = '@mavonengine/auth'
const LINK_RE = /https?:\/\/\S+token=([\w%-]+)/
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
  vi.unstubAllEnvs()
})

/** The plugin on a server of its own, with a mail plugin that keeps what it is given */
async function started(options: Record<string, unknown> = {}, { mail = true, appUrl = undefined as string | undefined, appName = undefined as string | undefined } = {}) {
  const db = memoryDb()
  await runPluginMigrations(db, PKG, plugin.migrations)

  const sent: MailInput[] = []
  const mailApi = {
    send: vi.fn(async (input: MailInput) => void sent.push(input)),
  }
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
    requireAdmin: (_req: unknown, _res: unknown, next: () => void) => next(),
    table: (name: string) => tableName(PKG, name),
    identity: identityOf,
    // The game's address, from mavonengine.json or MAVONENGINE_APP_URL
    appUrl,
    appName,
    plugin: (pkg: string) => (pkg === '@mavonengine/mail' && mail
      ? mailApi
      : undefined),
  } as unknown as ServerPluginContext

  await plugin.setup(ctx)
  const app = express()
  plugin.http(app, ctx)
  const listening = app.listen(0)
  await new Promise(resolve => listening.once('listening', resolve))
  const origin = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`
  closers.push(async () => {
    plugin.destroy(ctx)
    await new Promise(resolve => listening.close(resolve))
  })

  async function request(method: string, path: string, { body, token, form }: { body?: unknown, token?: string, form?: Record<string, string> } = {}) {
    const headers: Record<string, string> = {}
    let payload: string | undefined
    if (form) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded'
      payload = new URLSearchParams(form).toString()
    }
    else if (body !== undefined) {
      headers['Content-Type'] = 'application/json'
      payload = JSON.stringify(body)
    }
    if (token)
      headers.Authorization = `Bearer ${token}`
    const res = await fetch(`${origin}${path.startsWith('http')
      ? path.slice(origin.length)
      : path}`, { method, headers, body: payload })
    const text = await res.text()
    let json: any
    try {
      json = text
        ? JSON.parse(text)
        : undefined
    }
    catch {
      json = undefined
    }
    return {
      status: res.status,
      headers: res.headers,
      json,
      text,
    }
  }

  async function register(username = 'Ada', email: string | null = 'ada@example.com') {
    const res = await request('POST', '/api/auth/register', {
      body: {
        username,
        password: 'correct horse',
        ...(email
          ? { email }
          : {}),
      },
    })
    expect(res.status).toBe(201)
    return res.json as { token: string, account: { id: string, email: string | null, emailVerified: boolean } }
  }

  /** The token in the link of the last mail to `to` */
  async function linkIn(to: string) {
    await vi.waitFor(() => expect(sent.some(m => m.to === to)).toBe(true))
    const mail = sent.filter(m => m.to === to).at(-1)!
    const match = LINK_RE.exec(mail.text)!
    return {
      mail,
      url: match[0],
      token: decodeURIComponent(match[1]),
    }
  }

  return {
    ctx,
    db,
    logger,
    origin,
    sent,
    mailApi,
    request,
    register,
    linkIn,
  }
}

describe('confirming the email', () => {
  it('mails a link when an account registers with one, and the link confirms it', async () => {
    const server = await started({}, { appName: 'Space Game' })
    const { token: session, account } = await server.register()
    expect(account.emailVerified).toBe(false)

    const { mail, url, token } = await server.linkIn('ada@example.com')
    expect(mail.subject).toBe('Confirm your email address')
    expect(mail.text).toContain('for Space Game')
    expect(mail.html).toContain(`href="${url.replace(/&/g, '&amp;')}"`)
    // In development the link goes where the request came to
    expect(url).toMatch(new RegExp(`^${server.origin}/api/auth/verify-email\\?token=`))

    const confirmed = await server.request('POST', '/api/auth/verify-email', {
      body: { token },
    })
    expect(confirmed.status).toBe(200)
    expect(confirmed.json.account).toMatchObject({ id: account.id, email: 'ada@example.com', emailVerified: true })
    expect((await server.request('GET', '/api/auth/me', { token: session })).json.account.emailVerified).toBe(true)

    // Once
    expect((await server.request('POST', '/api/auth/verify-email', {
      body: { token },
    })).status).toBe(400)
  })

  it('asks on the page before confirming, as mail scanners open links', async () => {
    const server = await started()
    await server.register()
    const { url, token } = await server.linkIn('ada@example.com')

    // Opening the link confirms nothing
    const page = await server.request('GET', url)
    expect(page.status).toBe(200)
    expect(page.text).toContain('Confirm that ada@example.com is your email address')
    expect(page.text).toContain('<form method="post" action="/api/auth/verify-email">')
    expect(page.headers.get('content-security-policy')).toContain('default-src \'none\'')
    expect(page.headers.get('referrer-policy')).toBe('no-referrer')
    expect(page.headers.get('x-frame-options')).toBe('DENY')
    expect((await server.request('GET', url)).status).toBe(200)

    // Its button does
    const done = await server.request('POST', '/api/auth/verify-email', {
      form: { token },
    })
    expect(done.status).toBe(200)
    expect(done.text).toContain('ada@example.com is confirmed')

    const gone = await server.request('GET', url)
    expect(gone.status).toBe(400)
    expect(gone.text).toContain('doesn&#39;t work any more')
  })

  it('mails a link for a changed email, and the old link stops working', async () => {
    const server = await started()
    const { token: session } = await server.register()
    const first = await server.linkIn('ada@example.com')

    const changed = await server.request('POST', '/api/auth/email', {
      token: session,
      body: { email: 'ada@new.example.com' },
    })
    expect(changed.json.account).toMatchObject({ email: 'ada@new.example.com', emailVerified: false })
    const second = await server.linkIn('ada@new.example.com')

    expect((await server.request('POST', '/api/auth/verify-email', {
      body: { token: first.token },
    })).status).toBe(400)
    expect((await server.request('POST', '/api/auth/verify-email', {
      body: { token: second.token },
    })).json.account.emailVerified).toBe(true)
  })

  it('changes the email only to one that is free, and takes it away with null', async () => {
    const server = await started()
    const { token: session } = await server.register()
    await server.register('Bob', 'bob@example.com')

    expect((await server.request('POST', '/api/auth/email', {
      token: session,
      body: { email: 'BOB@example.com' },
    })).status).toBe(409)
    expect((await server.request('POST', '/api/auth/email', {
      token: session,
      body: { email: 'nope' },
    })).status).toBe(400)
    expect((await server.request('POST', '/api/auth/email', {
      body: { email: 'x@example.com' },
    })).status).toBe(401)
    expect((await server.request('POST', '/api/auth/email', {
      token: session,
      body: { email: null },
    })).json.account).toMatchObject({ email: null, emailVerified: false })
  })

  it('mails a new link when asked, a few an hour at most', async () => {
    const server = await started()
    const { token: session } = await server.register()
    await server.linkIn('ada@example.com')

    for (let i = 1; i < MAILS_PER_ADDRESS_PER_HOUR; i++)
      expect((await server.request('POST', '/api/auth/verify-email/send', { token: session })).status).toBe(202)
    const tooMany = await server.request('POST', '/api/auth/verify-email/send', { token: session })
    expect(tooMany.status).toBe(429)
    expect(Number(tooMany.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(server.sent).toHaveLength(MAILS_PER_ADDRESS_PER_HOUR)
  })

  it('has nothing to mail for an account without an email, or a confirmed one', async () => {
    const server = await started()
    const { token: session } = await server.register('Ada', null)
    expect((await server.request('POST', '/api/auth/verify-email/send', { token: session })).status).toBe(409)
    expect(server.sent).toEqual([])
  })

  it('registers without mailing when there is no mail plugin, or when told not to', async () => {
    const noMail = await started({}, { mail: false })
    await noMail.register()
    expect(noMail.logger.info).toHaveBeenCalledWith(expect.stringContaining('no mail plugin'))
    const { token } = await noMail.register('Bob', 'bob@example.com')
    expect((await noMail.request('POST', '/api/auth/verify-email/send', { token })).status).toBe(503)

    const off = await started({ verifyEmail: false })
    await off.register()
    expect(off.sent).toEqual([])
  })

  it('links to the game\'s own page when it has one', async () => {
    const server = await started({ verifyUrl: 'https://game.example.com/verify?token={token}' })
    await server.register()
    const { url } = await server.linkIn('ada@example.com')
    expect(url).toMatch(/^https:\/\/game\.example\.com\/verify\?token=/)
  })
})

describe('resetting a forgotten password', () => {
  it('mails a link that sets a new password, logs in, logs everyone else out and confirms the email', async () => {
    const server = await started({}, { appUrl: 'https://game.example.com' })
    const { token: oldSession } = await server.register()
    await server.linkIn('ada@example.com')

    const asked = await server.request('POST', '/api/auth/forgot-password', {
      body: { email: 'ADA@example.com' },
    })
    expect(asked.status).toBe(202)
    const { mail, url, token } = await server.linkIn('ada@example.com')
    expect(mail.subject).toBe('Reset your password')
    expect(url).toMatch(/^https:\/\/game\.example\.com\/api\/auth\/reset-password\?token=/)

    expect((await server.request('POST', '/api/auth/reset-password', {
      body: { token, password: 'short' },
    })).status).toBe(400)
    // A password that can't be used leaves the link working
    const reset = await server.request('POST', '/api/auth/reset-password', {
      body: { token, password: 'brand new horse' },
    })
    expect(reset.status).toBe(200)
    expect(reset.json.account).toMatchObject({ name: 'Ada', emailVerified: true })
    expect(reset.json.token).toEqual(expect.any(String))

    expect((await server.request('GET', '/api/auth/me', { token: oldSession })).status).toBe(401)
    expect((await server.request('POST', '/api/auth/login', {
      body: { username: 'Ada', password: 'correct horse' },
    })).status).toBe(401)
    expect((await server.request('POST', '/api/auth/login', {
      body: { username: 'ada', password: 'brand new horse' },
    })).status).toBe(200)
    // Once
    expect((await server.request('POST', '/api/auth/reset-password', {
      body: { token, password: 'another new one' },
    })).status).toBe(400)
  })

  it('answers the same for an email no account has, and mails nothing', async () => {
    const server = await started()
    await server.register()
    server.sent.length = 0

    const unknown = await server.request('POST', '/api/auth/forgot-password', {
      body: { email: 'nobody@example.com' },
    })
    const known = await server.request('POST', '/api/auth/forgot-password', {
      body: { email: 'ada@example.com' },
    })
    expect([unknown.status, unknown.json]).toEqual([known.status, known.json])
    await server.linkIn('ada@example.com')
    expect(server.sent.map(m => m.to)).toEqual(['ada@example.com'])
  })

  it('offers the form on the page, and checks the two passwords are the same', async () => {
    const server = await started()
    await server.register()
    await server.request('POST', '/api/auth/forgot-password', {
      body: { email: 'ada@example.com' },
    })
    await vi.waitFor(() => expect(server.sent.some(m => m.subject === 'Reset your password')).toBe(true))
    const { url, token } = await server.linkIn('ada@example.com')

    const page = await server.request('GET', url)
    expect(page.text).toContain('<input id="password" name="password" type="password"')
    expect(page.headers.get('referrer-policy')).toBe('no-referrer')

    const mismatch = await server.request('POST', '/api/auth/reset-password', {
      form: { token, password: 'brand new horse', confirm: 'brand new hors' },
    })
    expect(mismatch.status).toBe(400)
    expect(mismatch.text).toContain('The two passwords are not the same')
    // Still offered: the link works
    expect(mismatch.text).toContain('name="token"')

    const done = await server.request('POST', '/api/auth/reset-password', {
      form: { token, password: 'brand new horse', confirm: 'brand new horse' },
    })
    expect(done.status).toBe(200)
    expect(done.text).toContain('Your password is changed')
    expect((await server.request('POST', '/api/auth/login', {
      body: { username: 'Ada', password: 'brand new horse' },
    })).status).toBe(200)
  })

  it('only takes the latest link, and none once the email changed or the password was changed', async () => {
    const server = await started()
    const { token: session } = await server.register()
    const ask = async () => {
      server.sent.length = 0
      await server.request('POST', '/api/auth/forgot-password', {
        body: { email: 'ada@example.com' },
      })
      return (await server.linkIn('ada@example.com')).token
    }

    const first = await ask()
    const second = await ask()
    expect((await server.request('POST', '/api/auth/reset-password', {
      body: { token: first, password: 'brand new horse' },
    })).status).toBe(400)

    await server.request('POST', '/api/auth/password', {
      token: session,
      body: { current: 'correct horse', password: 'changed horse' },
    })
    expect((await server.request('POST', '/api/auth/reset-password', {
      body: { token: second, password: 'brand new horse' },
    })).status).toBe(400)
  })

  it('caps the resets an address asks for, and the mails one email gets', async () => {
    const server = await started({ resetsPerHour: 2 })
    await server.register()
    server.sent.length = 0

    expect((await server.request('POST', '/api/auth/forgot-password', {
      body: { email: 'x@example.com' },
    })).status).toBe(202)
    expect((await server.request('POST', '/api/auth/forgot-password', {
      body: { email: 'y@example.com' },
    })).status).toBe(202)
    const tooMany = await server.request('POST', '/api/auth/forgot-password', {
      body: { email: 'ada@example.com' },
    })
    expect(tooMany.status).toBe(429)
    expect(tooMany.headers.get('retry-after')).toEqual(expect.any(String))

    // Many addresses asking for one email: it still only gets a few mails
    const many = await started({ resetsPerHour: 100 })
    await many.register()
    many.sent.length = 0
    for (let i = 0; i < MAILS_PER_ADDRESS_PER_HOUR + 3; i++) {
      await many.request('POST', '/api/auth/forgot-password', {
        body: { email: 'ada@example.com' },
      })
    }
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(many.sent).toHaveLength(MAILS_PER_ADDRESS_PER_HOUR)
  })

  it('mails no link to accounts without a password, guests or disabled ones', async () => {
    const server = await started({ guests: true })
    const { account } = await server.register()
    server.sent.length = 0
    await server.db.updateTable('auth_accounts').set({ disabled_at: '2026-01-01T00:00:00.000Z' }).where('id', '=', account.id).execute()

    await server.request('POST', '/api/auth/forgot-password', {
      body: { email: 'ada@example.com' },
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(server.sent).toEqual([])
  })

  it('needs a mail plugin, and in production the game\'s address', async () => {
    const noMail = await started({}, { mail: false })
    expect((await noMail.request('POST', '/api/auth/forgot-password', {
      body: { email: 'ada@example.com' },
    })).status).toBe(503)

    vi.stubEnv('NODE_ENV', 'production')
    const noUrl = await started()
    expect(noUrl.logger.warn).toHaveBeenCalledWith(expect.stringContaining('set "appUrl"'))
    const res = await noUrl.request('POST', '/api/auth/forgot-password', {
      body: { email: 'ada@example.com' },
    })
    expect(res.status).toBe(503)
    expect(res.json.error).toContain('appUrl')
  })

  it('never builds links from the Host header in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const server = await started({}, { appUrl: 'https://game.example.com' })
    await server.register()
    server.sent.length = 0

    const res = await fetch(`${server.origin}/api/auth/forgot-password`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Host': 'evil.example.com' },
      body: JSON.stringify({ email: 'ada@example.com' }),
    })
    expect(res.status).toBe(202)
    const { url } = await server.linkIn('ada@example.com')
    expect(url.startsWith('https://game.example.com/')).toBe(true)
  })
})

describe('auth options for mail', () => {
  it('takes only link templates that are http(s) URLs with {token}', () => {
    expect(parseOptions({ verifyUrl: 'https://a.example.com/v?t={token}' })).toMatchObject({ verifyUrl: 'https://a.example.com/v?t={token}' })
    // A template without {token} would mail links that can't work
    expect(parseOptions({ resetUrl: 'https://a.example.com/r' }).resetUrl).toBeUndefined()
    expect(parseOptions({ resetUrl: 'javascript:alert(1)//{token}' }).resetUrl).toBeUndefined()
    expect(parseOptions({})).toMatchObject({ verifyEmail: true, resetsPerHour: 5 })
    // The game's address isn't the plugin's: it is appUrl in mavonengine.json, ctx.appUrl
    expect(parseOptions({ appUrl: 'https://a.example.com' })).not.toHaveProperty('appUrl')
  })
})
