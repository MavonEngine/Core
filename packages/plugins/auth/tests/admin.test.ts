import type { ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { AddressInfo } from 'node:net'
import { identityOf } from '@mavonengine/core/Networking/identity'
import AdminPanel from '@mavonengine/core/Networking/Server/Admin/AdminPanel'
import { runPluginMigrations } from '@mavonengine/core/Plugins/Database/migrate'
import { tableName } from '@mavonengine/core/Plugins/Database/tables'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PAGE_SIZE } from '../src/admin'
import plugin, { auth } from '../src/server'
import { memoryDb } from './memoryDb'

const PKG = '@mavonengine/auth'
const ADMIN = 'Bearer admin-token'
const closers: (() => Promise<void>)[] = []

afterEach(async () => {
  await Promise.all(closers.splice(0).map(close => close()))
})

/** The plugin on a server with core's admin panel, the way a server hands it to plugins */
async function started({ database = true } = {}) {
  const db = database
    ? memoryDb()
    : undefined
  if (db)
    await runPluginMigrations(db, PKG, plugin.migrations)

  const app = express()
  const panel = new AdminPanel({
    adminToken: {
      configured: true,
      matches: candidate => candidate === 'admin-token',
    },
    production: () => false,
  })
  panel.mount(app)
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const ctx = {
    package: PKG,
    options: {},
    server: {},
    logger,
    db,
    requireAdmin: panel.guard,
    admin: panel.forPlugin(PKG),
    table: (name: string) => tableName(PKG, name),
    identity: identityOf,
  } as unknown as ServerPluginContext

  await plugin.setup(ctx)
  plugin.http(app, ctx)
  const listening = app.listen(0, '127.0.0.1')
  await new Promise(resolve => listening.once('listening', resolve))
  const base = `http://127.0.0.1:${(listening.address() as AddressInfo).port}`
  closers.push(async () => {
    plugin.destroy(ctx)
    await new Promise(resolve => listening.close(resolve))
  })

  const get = (path: string, headers: Record<string, string> = { Authorization: ADMIN }) => fetch(`${base}${path}`, { headers, redirect: 'manual' })
  const post = (path: string, form: Record<string, string>, headers: Record<string, string> = {}) => fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Authorization': ADMIN, 'Content-Type': 'application/x-www-form-urlencoded', ...headers },
    body: new URLSearchParams(form).toString(),
    redirect: 'manual',
  })

  /** A game connection of `id`, as core hands it to the plugin */
  function connect(id: string) {
    const channel = {
      id: Math.random().toString(36),
      userData: { id, name: 'x' },
      close: vi.fn(async () => {}),
    }
    plugin.onConnection(channel as any, {}, ctx)
    return channel
  }

  return {
    ctx,
    panel,
    get,
    post,
    connect,
    logger,
    hooks: auth(ctx.server),
    db: db!,
  }
}

async function register(get: Awaited<ReturnType<typeof started>>['get'], username: string, email?: string) {
  const res = await fetch(new URL('/api/auth/register', (await get('/admin/')).url), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      username,
      password: 'correct horse battery',
      ...(email
        ? { email }
        : {}),
    }),
  })
  return (await res.json()).account as { id: string }
}

describe('admin pages', () => {
  it('lists the accounts in the admin panel, with Guests and Disabled below it in the sidebar', async () => {
    const { get, panel, connect } = await started()
    const ada = await register(get, 'ada', 'ada@example.com')
    await register(get, 'bob')
    connect(ada.id)

    expect(panel.list().map(page => page.path)).toContain('accounts')
    expect((await get('/admin/accounts/', {})).status).toBe(401)

    const html = await (await get('/admin/accounts/')).text()
    expect(html).toContain('class="adm-sidebar"')
    expect(html).toContain('href="/admin/accounts/guests/"')
    expect(html).toContain('href="/admin/accounts/disabled/"')
    expect(html).toContain('ada@example.com')
    expect(html).toContain('>online<')
    expect(html).toMatch(/<h2>Accounts<\/h2><div class="adm-stat">2<\/div>/)
    expect(html).toMatch(/<h2>Online now<\/h2><div class="adm-stat">1<\/div>/)
    expect(html).toContain(`action="/admin/accounts/actions/${ada.id}/disable"`)
    expect(html).toContain('1–2 of 2')
  })

  it('searches, and filters guests and disabled accounts', async () => {
    const { get, hooks } = await started()
    await register(get, 'ada')
    const bob = await register(get, 'bob')
    await hooks.disable(bob.id)

    const search = await (await get('/admin/accounts/?q=ad')).text()
    expect(search).toContain('>ada<')
    expect(search).not.toContain('>bob<')

    const disabled = await (await get('/admin/accounts/disabled/')).text()
    expect(disabled).toContain('>bob<')
    expect(disabled).not.toContain('>ada<')
    expect(disabled).toContain(`action="/admin/accounts/actions/${bob.id}/enable"`)
    expect(disabled).toContain('href="/admin/accounts/disabled/" aria-current="page"')

    expect(await (await get('/admin/accounts/guests/')).text()).toContain('No guest accounts.')
    expect(await (await get('/admin/accounts/?q=%3Cb%3E')).text()).toContain('No accounts match “&lt;b&gt;”.')
  })

  it('disables, enables and logs out with its buttons, then goes back to the page it was on', async () => {
    const { get, post, connect, hooks } = await started()
    const ada = await register(get, 'ada')
    const channel = connect(ada.id)

    const disable = await post(`/admin/accounts/actions/${ada.id}/disable`, { back: '/admin/accounts/?q=ad' })
    expect(disable.status).toBe(303)
    expect(disable.headers.get('location')).toBe('/admin/accounts/?q=ad&notice=disabled')
    expect((await hooks.account(ada.id))?.disabledAt).toBeTruthy()
    expect(channel.close).toHaveBeenCalled()
    expect(await (await get(disable.headers.get('location')!)).text()).toContain('The account is disabled')

    const enable = await post(`/admin/accounts/actions/${ada.id}/enable`, { back: '/admin/accounts/disabled/' })
    expect(enable.headers.get('location')).toBe('/admin/accounts/disabled/?notice=enabled')
    expect((await hooks.account(ada.id))?.disabledAt).toBeNull()

    await register(get, 'bob')
    const logout = await post(`/admin/accounts/actions/${ada.id}/logout`, { back: '/admin/accounts/' })
    expect(logout.headers.get('location')).toBe('/admin/accounts/?notice=logged-out&ended=0')

    expect((await post('/admin/accounts/actions/nobody/disable', {})).headers.get('location')).toBe('/admin/accounts/?notice=missing')
    expect((await post(`/admin/accounts/actions/${ada.id}/delete`, {})).status).toBe(404)
  })

  it('takes the panel\'s own form posts, which browsers send with Origin null under its referrer policy', async () => {
    const { get, post, hooks } = await started()
    const ada = await register(get, 'ada')

    const res = await post(`/admin/accounts/actions/${ada.id}/disable`, {}, { 'Origin': 'null', 'Sec-Fetch-Site': 'same-origin' })
    expect(res.status).toBe(303)
    expect((await hooks.account(ada.id))?.disabledAt).toBeTruthy()
  })

  it('only goes back to its own pages', async () => {
    const { get, post } = await started()
    const ada = await register(get, 'ada')

    for (const back of [
      'https://evil.example/',
      '//evil.example/admin/accounts/',
      '/admin/other/',
      '/admin/accounts/\\evil',
    ])
      expect((await post(`/admin/accounts/actions/${ada.id}/disable`, { back })).headers.get('location')).toBe('/admin/accounts/?notice=disabled')
  })

  it('refuses buttons pressed on another site, and anyone without the admin login', async () => {
    const { get, post, hooks, logger } = await started()
    const ada = await register(get, 'ada')

    expect((await post(`/admin/accounts/actions/${ada.id}/disable`, {}, { 'Origin': 'https://evil.example', 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await post(`/admin/accounts/actions/${ada.id}/disable`, {}, { Origin: 'https://evil.example' })).status).toBe(403)
    expect((await post(`/admin/accounts/actions/${ada.id}/disable`, {}, { 'Origin': 'null', 'Sec-Fetch-Site': 'same-site' })).status).toBe(403)
    expect((await post(`/admin/accounts/actions/${ada.id}/disable`, {}, { Origin: 'null' })).status).toBe(403)
    expect((await post(`/admin/accounts/actions/${ada.id}/disable`, {}, { Authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await hooks.account(ada.id))?.disabledAt).toBeNull()
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('from another site'))
  })

  it('pages through many accounts', async () => {
    const { get } = await started()
    for (let i = 0; i < PAGE_SIZE + 3; i++)
      await register(get, `player${i}`)

    const first = await (await get('/admin/accounts/')).text()
    expect(first).toContain(`1–${PAGE_SIZE} of ${PAGE_SIZE + 3}`)
    expect(first).toContain(`href="/admin/accounts/?offset=${PAGE_SIZE}"`)

    const second = await (await get(`/admin/accounts/?offset=${PAGE_SIZE}`)).text()
    expect(second).toContain(`${PAGE_SIZE + 1}–${PAGE_SIZE + 3} of ${PAGE_SIZE + 3}`)
  })

  it('says so when there is no database', async () => {
    const { get } = await started({ database: false })

    expect(await (await get('/admin/accounts/')).text()).toContain('Accounts are unavailable')
  })
})
