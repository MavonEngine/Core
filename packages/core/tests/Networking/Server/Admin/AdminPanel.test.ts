import type { Server as NodeServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { AdminPanelOptions } from '../../../../src/Networking/Server/Admin/AdminPanel'
import { Buffer } from 'node:buffer'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AdminPanel, { escapeHtml } from '../../../../src/Networking/Server/Admin/AdminPanel'

let listener: NodeServer | undefined

afterEach(() => {
  listener?.close()
  listener = undefined
})

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

async function serve({ token, production = false, options, setup }: { token?: string, production?: boolean, options?: AdminPanelOptions, setup?(panel: AdminPanel, app: express.Express): void } = {}) {
  const app = express()
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const panel = new AdminPanel({
    adminToken: {
      configured: !!token,
      matches: candidate => !!token && candidate === token,
    },
    logger: logger as any,
    appName: () => 'My game',
    production: () => production,
  }, options)
  panel.mount(app)
  panel.page({
    path: '',
    label: 'Overview',
    icon: 'dashboard',
    order: 0,
    render: () => '<p id="start">start</p>',
  })
  setup?.(panel, app)
  // Stands in for the game client's page fallback
  app.use((_req, res) => void res.send('game'))

  listener = await new Promise<NodeServer>((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
  const { port } = listener.address() as AddressInfo
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, { headers, redirect: 'manual' })
  return { panel, get, logger }
}

describe('adminPanel', () => {
  it('serves the layout with the sidebar, its files and security headers', async () => {
    const { get } = await serve()

    const res = await get('/admin/')
    const html = await res.text()
    expect(res.status).toBe(200)
    expect(res.headers.get('content-security-policy')).toContain('default-src \'self\'')
    expect(res.headers.get('x-frame-options')).toBe('DENY')
    expect(html).toContain('<p id="start">start</p>')
    expect(html).toContain('href="/admin/_admin/admin.css"')
    expect(html).toContain('My game')
    expect(html).toMatch(/<a class="adm-link" href="\/admin\/" aria-current="page">/)

    expect((await get('/admin/_admin/admin.css')).headers.get('content-type')).toContain('text/css')
    expect((await get('/admin/_admin/admin.js')).headers.get('content-type')).toContain('text/javascript')
  })

  it('redirects pages to their trailing slash, keeping the query', async () => {
    const { get } = await serve({
      setup: panel => panel.page({
        path: 'stats',
        label: 'Stats',
        render: () => '',
      }),
    })

    const res = await get('/admin/stats?x=1')
    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/admin/stats/?x=1')
    expect((await get('/admin')).headers.get('location')).toBe('/admin/')
  })

  it('lists plugin pages under their group with their sub links, open only on the current page', async () => {
    const { get } = await serve({
      setup: (panel) => {
        const plugin = panel.forPlugin('@acme/chat')
        plugin.page({
          path: 'chat',
          label: 'Chat',
          icon: 'chat',
          children: [
            { label: 'Live', href: '#live' },
            {
              label: 'Mutes',
              href: 'mutes',
              render: () => ({ html: '<p>mutes</p>', title: 'Muted players' }),
            },
            { label: 'Docs', href: 'https://example.com/docs' },
          ],
          render: () => ({
            html: '<p>chat</p>',
            styles: ['/admin/chat/style.css'],
            scripts: ['/admin/chat/app.js'],
            data: { 'poll-interval': '500', 'Bad Key': 'x' },
          }),
        })
      },
    })

    const start = await (await get('/admin/')).text()
    expect(start).toContain('Plugins')
    expect(start).toContain('href="/admin/chat/"')
    expect(start).not.toContain('adm-subnav')

    const chat = await (await get('/admin/chat/')).text()
    expect(chat).toContain('<p>chat</p>')
    expect(chat).toContain('<link rel="stylesheet" href="/admin/chat/style.css">')
    expect(chat).toContain('<script type="module" src="/admin/chat/app.js"></script>')
    expect(chat).toContain('data-poll-interval="500"')
    expect(chat).not.toContain('Bad Key')
    expect(chat).toContain('href="/admin/chat/#live" data-hash="live"')
    expect(chat).toContain('href="/admin/chat/mutes/"')
    expect(chat).toContain('href="https://example.com/docs"')

    const mutes = await (await get('/admin/chat/mutes/')).text()
    expect(mutes).toContain('<p>mutes</p>')
    expect(mutes).toContain('<h1 class="adm-title">Muted players</h1>')
    expect(mutes).toContain('href="/admin/chat/mutes/" aria-current="page"')
  })

  it('leaves paths without a page to the routes after it, behind its login', async () => {
    const { get } = await serve({
      token: 'secret',
      setup: (panel, app) => {
        app.get(panel.url('chat/api/messages'), (_req, res) => void res.json({ messages: [] }))
      },
    })

    expect((await get('/admin/chat/api/messages')).status).toBe(401)
    expect(await (await get('/admin/chat/api/messages', { Authorization: 'Bearer secret' })).json()).toEqual({ messages: [] })
    expect(await (await get('/admin/nothing/here', { Authorization: 'Bearer secret' })).text()).toBe('game')
    expect(await (await get('/administrator')).text()).toBe('game')
  })

  it('escapes the labels it is given and shows a failing page as an error', async () => {
    const { get, logger } = await serve({
      setup: (panel) => {
        panel.page({
          path: 'x',
          label: '<b>X</b>',
          render: () => {
            throw new Error('<oops>')
          },
        })
      },
    })

    const res = await get('/admin/x/')
    const html = await res.text()
    expect(res.status).toBe(500)
    expect(html).toContain('&lt;b&gt;X&lt;/b&gt;')
    expect(html).toContain('This page failed: &lt;oops&gt;')
    expect(logger.error).toHaveBeenCalled()
    expect(escapeHtml('"a" & \'b\'')).toBe('&quot;a&quot; &amp; &#39;b&#39;')
  })

  describe('login', () => {
    it('takes the admin token as the password or bearer token', async () => {
      const { get, logger } = await serve({ token: 'secret' })

      const prompt = await get('/admin/')
      expect(prompt.status).toBe(401)
      expect(prompt.headers.get('www-authenticate')).toBe('Basic realm="MavonEngine admin", charset="UTF-8"')
      expect((await get('/admin/', {
        Authorization: basic('anyone', 'wrong'),
      })).status).toBe(401)
      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('failed login for "anyone"'))

      expect((await get('/admin/', {
        Authorization: basic('anyone', 'secret'),
      })).status).toBe(200)
      expect((await get('/admin/', { Authorization: 'Bearer secret' })).status).toBe(200)
    })

    it('takes the logins plugins add', async () => {
      const { get } = await serve({
        token: 'secret',
        setup: panel => panel.forPlugin('@acme/users').addLogin(async (user, password) => user === 'bob' && password === 'hunter2'),
      })

      expect((await get('/admin/', {
        Authorization: basic('bob', 'hunter2'),
      })).status).toBe(200)
      expect((await get('/admin/', {
        Authorization: basic('bob', 'nope'),
      })).status).toBe(401)
    })

    it('locks an address out after too many failed logins', async () => {
      const { get } = await serve({ token: 'secret' })

      for (let i = 0; i < 10; i++) {
        await get('/admin/', {
          Authorization: basic('x', 'wrong'),
        })
      }

      const res = await get('/admin/', {
        Authorization: basic('x', 'secret'),
      })
      expect(res.status).toBe(429)
      expect(res.headers.get('retry-after')).toBeTruthy()
    })

    it('only answers this machine without a token or login, and stays off in production', async () => {
      const dev = await serve()
      expect(dev.panel.enabled).toBe(true)
      expect((await dev.get('/admin/')).status).toBe(200)
      listener?.close()

      const prod = await serve({ production: true })
      expect(prod.panel.enabled).toBe(false)
      expect(await (await prod.get('/admin/')).text()).toBe('game')
    })

    it('is on in production once the server has a token', async () => {
      const { panel, get } = await serve({ production: true, token: 'secret' })

      expect(panel.enabled).toBe(true)
      expect((await get('/admin/', { Authorization: 'Bearer secret' })).status).toBe(200)
    })
  })

  it('can be turned off or moved, but not to the site root', async () => {
    const off = await serve({
      options: { enabled: false },
    })
    expect(await (await off.get('/admin/')).text()).toBe('game')
    listener?.close()

    const moved = await serve({
      options: { path: '/ops/' },
    })
    expect(moved.panel.url('chat')).toBe('/ops/chat')
    expect((await moved.get('/ops/')).status).toBe(200)

    expect(() => new AdminPanel({
      adminToken: {
        configured: false,
        matches: () => false,
      },
    }, { path: '/' })).toThrow('site root')
  })

  it('shows the runtime, the server scene graph and physics on the Overview', async () => {
    const { registerEnginePages } = await import('../../../../src/Networking/Server/Admin/enginePages')
    const { REVISION } = await import('three')
    const health = () => ({
      serverTime: 'now',
      uptime: 75,
      players: 2,
      world: { entities: 9 },
      physics: { bodies: 3 },
    })
    const inspector = {
      sceneGraph: () => ({
        objects: 5,
        byType: { Mesh: 3, Group: 2 },
        meshes: 3,
        triangles: 36,
        lights: 0,
      }),
      physics: () => ({
        bodies: 3,
        dynamic: 2,
        fixed: 1,
        kinematic: 0,
        sleeping: 1,
        colliders: 4,
        gravity: { x: 0, y: -9.81, z: 0 },
        timestep: 1 / 60,
      }),
    }
    const { get } = await serve({
      setup: panel => registerEnginePages(panel, {
        health,
        routes: () => [],
        inspector,
      }),
    })

    const html = await (await get('/admin/')).text()
    expect(html).toContain(`<dt>Three.js</dt><dd>r${REVISION}</dd>`)
    // Rapier isn't initialised in this test, so its version can't be read: in use, without one
    expect(html).toContain('<dt>Rapier</dt><dd>in use</dd>')
    expect(html).toContain('<h2>Server scene graph (three.js)</h2>')
    expect(html).toContain('<dt>Triangles</dt><dd>36</dd>')
    expect(html).toContain('<dt>Gravity</dt><dd>0, -9.81, 0</dd>')
    expect(html).toContain('<dt>Timestep</dt><dd>16.67 ms</dd>')
    // No Scene card or Scene objects table
    expect(html).not.toContain('<h2>Scene</h2>')
    expect(html).not.toContain('Scene objects')
  })

  it('says so on the Overview without physics', async () => {
    const { registerEnginePages } = await import('../../../../src/Networking/Server/Admin/enginePages')
    const health = () => ({
      serverTime: 'now',
      uptime: 5,
      players: 0,
      world: { entities: 0 },
      physics: {},
    })
    const inspector = {
      sceneGraph: () => ({
        objects: 0,
        byType: {},
        meshes: 0,
        triangles: 0,
        lights: 0,
      }),
      physics: () => null,
    }
    const { get } = await serve({
      setup: panel => registerEnginePages(panel, {
        health,
        routes: () => [],
        inspector,
      }),
    })

    const html = await (await get('/admin/')).text()
    expect(html).toContain('<dt>Rapier</dt><dd><span class="adm-muted">not used on the server</span></dd>')
    expect(html).toContain('The server runs without a physics world.')
  })
})
