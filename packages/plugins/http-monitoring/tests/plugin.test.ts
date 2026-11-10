import type { AddressInfo } from 'node:net'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import express from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import plugin, { createHttpMonitoring, mountMonitoring, resolveOptions } from '../src/index'

// htpasswd -nbm bob hunter2
const BOB = 'bob:$apr1$/JmjNbl4$7OwIOno5XIdi.TZFKCN801'

let dir: string
let listener: ReturnType<ReturnType<typeof express>['listen']> | undefined

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mavonengine-monitoring-'))
})

afterEach(() => {
  listener?.close()
  listener = undefined
  rmSync(dir, { recursive: true, force: true })
})

const basic = (user: string, password: string) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

function fakeServer({ logs = true, requests = true } = {}) {
  return {
    metrics: { snapshot: vi.fn(() => ({ schemaVersion: 1, engineVersion: '0.0.22', players: [] })) },
    logs: logs ? { since: vi.fn((after: number) => ({ entries: [{ id: after + 1, level: 'info', message: 'hi', timestamp: 0 }], latestId: after + 1 })) } : undefined,
    requests: requests ? { since: vi.fn(() => ({ entries: [], latestId: 0 })), ignorePrefix: vi.fn() } : undefined,
  }
}

/** Mount the dashboard on a fresh Express app and listen on a random port */
async function serve(options: Record<string, unknown> = {}, { env = {}, server = fakeServer(), adminToken }: { env?: Record<string, string>, server?: ReturnType<typeof fakeServer>, adminToken?: string } = {}) {
  const app = express()
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  // What core hands every plugin: checks the server's admin token without telling it
  const admin = adminToken === undefined ? undefined : { configured: !!adminToken, matches: (candidate: string) => !!adminToken && candidate === adminToken }
  const mounted = mountMonitoring(app, { server: server as any, logger: logger as any, options, projectRoot: dir, adminToken: admin }, env)
  // Stands in for the game client's page fallback, which comes after plugin routes
  app.use((_req, res) => void res.status(200).send('game'))

  listener = app.listen(0, '127.0.0.1')
  await new Promise(r => listener!.once('listening', r))
  const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
  return { mounted, logger, server, get: (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers, redirect: 'manual' }) }
}

describe('resolveOptions', () => {
  it('has defaults and normalizes the path', () => {
    expect(resolveOptions({}, dir, {})).toEqual({ path: '/monitoring', realm: 'MavonEngine monitoring', pollIntervalMs: 1000, credentials: undefined })
    expect(resolveOptions({ path: 'ops/stats/' }, dir, {}).path).toBe('/ops/stats')
  })

  it('refuses the site root, which would hide the game', () => {
    expect(() => resolveOptions({ path: '/' }, dir, {})).toThrow('can\'t be the site root')
  })

  it('resolves the htpasswd file from the project root, the option before the environment', () => {
    expect(resolveOptions({ htpasswd: '.htpasswd' }, dir, { MAVONENGINE_MONITORING_HTPASSWD: '/etc/other' }).credentials)
      .toEqual({ kind: 'htpasswd', path: resolve(dir, '.htpasswd') })
    expect(resolveOptions({}, dir, { MAVONENGINE_MONITORING_HTPASSWD: resolve('/etc/monitoring') }).credentials)
      .toEqual({ kind: 'htpasswd', path: resolve('/etc/monitoring') })
  })

  it('takes a single user from the environment', () => {
    expect(resolveOptions({}, dir, { MAVONENGINE_MONITORING_USER: 'ops', MAVONENGINE_MONITORING_PASSWORD: 'pw' }).credentials)
      .toEqual({ kind: 'user', user: 'ops', password: 'pw' })
    expect(resolveOptions({}, dir, { MAVONENGINE_MONITORING_USER: 'ops' }).credentials).toBeUndefined()
  })

  it('keeps the poll interval sensible', () => {
    expect(resolveOptions({ pollIntervalMs: 10 }, dir, {}).pollIntervalMs).toBe(250)
    expect(resolveOptions({ pollIntervalMs: 'x' as any }, dir, {}).pollIntervalMs).toBe(1000)
  })
})

describe('dashboard', () => {
  it('asks for a login, then serves the page, its files and the data', async () => {
    writeFileSync(join(dir, '.htpasswd'), BOB)
    const { get, server } = await serve({ htpasswd: '.htpasswd', pollIntervalMs: 2000 })
    const auth = { Authorization: basic('bob', 'hunter2') }

    const anonymous = await get('/monitoring/')
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('www-authenticate')).toBe('Basic realm="MavonEngine monitoring", charset="UTF-8"')
    expect((await get('/monitoring/api/metrics')).status).toBe(401)
    expect((await get('/monitoring/app.js', { Authorization: basic('bob', 'wrong') })).status).toBe(401)

    const page = await get('/monitoring/', auth)
    expect(page.status).toBe(200)
    expect(page.headers.get('content-type')).toContain('text/html')
    const html = await page.text()
    expect(html).toContain('data-poll-interval="2000"')
    expect(html).toContain('<script type="module" src="app.js"></script>')

    for (const [file, type] of [['app.js', 'text/javascript'], ['format.js', 'text/javascript'], ['style.css', 'text/css']]) {
      const res = await get(`/monitoring/${file}`, auth)
      expect(res.status).toBe(200)
      expect(res.headers.get('content-type')).toContain(type)
    }

    expect(await (await get('/monitoring/api/metrics', auth)).json()).toMatchObject({ engineVersion: '0.0.22' })
    expect(await (await get('/monitoring/api/logs?after=4', auth)).json()).toMatchObject({ latestId: 5 })
    expect(server.logs!.since).toHaveBeenCalledWith(4)
    expect(await (await get('/monitoring/api/requests?after=nope', auth)).json()).toEqual({ entries: [], latestId: 0 })
    expect(server.requests!.since).toHaveBeenCalledWith(0)
  })

  it('locks the page down with security headers, also on the login prompt', async () => {
    const { get } = await serve({}, { env: { MAVONENGINE_MONITORING_USER: 'ops', MAVONENGINE_MONITORING_PASSWORD: 'pw' } })

    for (const res of [await get('/monitoring/'), await get('/monitoring/', { Authorization: basic('ops', 'pw') })]) {
      expect(res.headers.get('cache-control')).toBe('no-store')
      expect(res.headers.get('x-frame-options')).toBe('DENY')
      expect(res.headers.get('x-content-type-options')).toBe('nosniff')
      expect(res.headers.get('content-security-policy')).toContain('default-src \'self\'')
    }
  })

  it('redirects to the trailing slash, which the page\'s relative URLs need', async () => {
    const { get } = await serve({}, { env: { MAVONENGINE_MONITORING_USER: 'ops', MAVONENGINE_MONITORING_PASSWORD: 'pw' } })

    const res = await get('/monitoring', { Authorization: basic('ops', 'pw') })

    expect(res.status).toBe(301)
    expect(res.headers.get('location')).toBe('/monitoring/')
  })

  it('leaves the rest of the site to the game', async () => {
    const { get } = await serve({}, { env: { MAVONENGINE_MONITORING_USER: 'ops', MAVONENGINE_MONITORING_PASSWORD: 'pw' } })

    expect(await (await get('/')).text()).toBe('game')
    expect(await (await get('/monitoringx')).text()).toBe('game')
  })

  it('serves under a custom path', async () => {
    const { get } = await serve({ path: '/ops' }, { env: { MAVONENGINE_MONITORING_USER: 'ops', MAVONENGINE_MONITORING_PASSWORD: 'pw' } })

    expect((await get('/ops/', { Authorization: basic('ops', 'pw') })).status).toBe(200)
    expect(await (await get('/monitoring/')).text()).toBe('game')
  })

  it('keeps its own polling out of the HTTP tab', async () => {
    const { server } = await serve()

    expect(server.requests!.ignorePrefix).toHaveBeenCalledWith('/monitoring/api/')
  })

  it('answers 404 for feeds the server doesn\'t keep', async () => {
    const { get } = await serve({}, { server: fakeServer({ logs: false, requests: false }) })

    expect((await get('/monitoring/api/logs')).status).toBe(404)
    expect((await get('/monitoring/api/requests')).status).toBe(404)
  })

  describe('without a login configured', () => {
    it('serves this machine in development and says so', async () => {
      const { get, logger, mounted } = await serve()

      expect(mounted).toBe(true)
      expect((await get('/monitoring/')).status).toBe(200)
      expect(logger.warn).toHaveBeenCalledWith('Monitoring dashboard at /monitoring/, only from this machine: the game server has no admin token')
    })

    it('stays off in production', async () => {
      const { get, logger, mounted } = await serve({}, { env: { NODE_ENV: 'production' } })

      expect(mounted).toBe(false)
      expect(await (await get('/monitoring/')).text()).toBe('game')
      expect(logger.warn.mock.calls[0][0]).toContain('Monitoring is off')
    })
  })

  describe('with the game server\'s admin token', () => {
    it('logs in with the token as the password, whatever the user name, also in production', async () => {
      const { get, logger, mounted } = await serve({}, { env: { NODE_ENV: 'production' }, adminToken: 'server-secret' })

      expect(mounted).toBe(true)
      expect(logger.info).toHaveBeenCalledWith('Monitoring dashboard at /monitoring/, login with the game server\'s admin token as the password')

      const prompt = await get('/monitoring/')
      expect(prompt.status).toBe(401)
      expect(prompt.headers.get('www-authenticate')).toContain('Basic realm=')
      expect((await get('/monitoring/', { Authorization: basic('admin', 'wrong') })).status).toBe(401)

      expect((await get('/monitoring/', { Authorization: basic('admin', 'server-secret') })).status).toBe(200)
      expect((await get('/monitoring/api/metrics', { Authorization: basic('anyone', 'server-secret') })).status).toBe(200)
      // Tools send it the way every other admin route takes it
      expect((await get('/monitoring/api/metrics', { Authorization: 'Bearer server-secret' })).status).toBe(200)
      expect((await get('/monitoring/api/metrics', { Authorization: 'Bearer wrong' })).status).toBe(401)
    })

    it('still takes the users of an htpasswd file next to it', async () => {
      writeFileSync(join(dir, '.htpasswd'), `${BOB}\n`)
      const { get, logger } = await serve({ htpasswd: '.htpasswd' }, { adminToken: 'server-secret' })

      expect((await get('/monitoring/', { Authorization: basic('bob', 'hunter2') })).status).toBe(200)
      expect((await get('/monitoring/', { Authorization: basic('bob', 'server-secret') })).status).toBe(200)
      expect((await get('/monitoring/', { Authorization: basic('bob', 'wrong') })).status).toBe(401)
      expect(logger.info.mock.calls.at(-1)![0]).toContain('login with the game server\'s admin token as the password or a user from ')
    })

    it('counts for nothing when the server has none', async () => {
      const { get, mounted, logger } = await serve({}, { env: { NODE_ENV: 'production' }, adminToken: '' })

      expect(mounted).toBe(false)
      expect(logger.warn.mock.calls[0][0]).toContain('MAVONENGINE_ADMIN_TOKEN')
      expect(await (await get('/monitoring/')).text()).toBe('game')
    })

    it('says that the plugin\'s own user and password are on their way out', async () => {
      const { get, logger } = await serve({}, { env: { MAVONENGINE_MONITORING_USER: 'ops', MAVONENGINE_MONITORING_PASSWORD: 'pw' } })

      expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('MAVONENGINE_MONITORING_USER and MAVONENGINE_MONITORING_PASSWORD are deprecated'))
      // They still work for now
      expect((await get('/monitoring/', { Authorization: basic('ops', 'pw') })).status).toBe(200)
    })
  })

  it('warns when the htpasswd file has nobody who can log in', async () => {
    writeFileSync(join(dir, '.htpasswd'), 'dave:rqXexS6ZhobKA\n')
    const { logger } = await serve({ htpasswd: '.htpasswd' })

    expect(logger.warn.mock.calls.map(c => c[0])).toEqual([
      expect.stringContaining('isn\'t supported (use bcrypt: htpasswd -B)'),
      expect.stringContaining('has no usable users, nobody can log in'),
    ])
  })
})

describe('plugin', () => {
  it('is a server plugin that mounts with its mavonengine.json options', () => {
    const app = express()
    const get = vi.spyOn(app, 'get')

    plugin.http!(app, { server: fakeServer(), logger: undefined, options: { path: '/stats' }, projectRoot: dir } as any)

    expect(get.mock.calls.map(c => c[0])).toContain('/stats/api/metrics')
  })

  it('takes defaults that mavonengine.json options override', () => {
    const app = express()
    const get = vi.spyOn(app, 'get')

    createHttpMonitoring({ path: '/ops', pollIntervalMs: 500 }).http!(app, { server: fakeServer(), logger: undefined, options: {}, projectRoot: dir } as any)

    expect(get.mock.calls.map(c => c[0])).toContain('/ops/api/metrics')
  })
})
