import type { Server as NodeServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { HttpServerOptions } from '../../../../src/Networking/Server/Http/HttpServer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import NetRecorder from '../../../../src/Networking/Debug/NetRecorder'
import HttpServer, { METRICS_CLIENT_TIMEOUT_MS, parseEntityQuery } from '../../../../src/Networking/Server/Http/HttpServer'
import LogBuffer from '../../../../src/Networking/Server/Stats/LogBuffer'
import RequestLog from '../../../../src/Networking/Server/Stats/RequestLog'

const health = { serverTime: 'now', uptime: 1, players: 0, world: { entities: 0 }, physics: {} }
const snapshot = { schemaVersion: 1, players: [] }

let listener: NodeServer | undefined

let http: HttpServer

async function serve(options: HttpServerOptions = {}) {
  const logger = { info: vi.fn() } as any
  const metrics = { health: () => health, snapshot: () => snapshot } as any

  http = new HttpServer(logger, metrics, options)

  listener = await new Promise<NodeServer>((resolve) => {
    const server = http.app.listen(0, '127.0.0.1', () => resolve(server))
  })

  const { port } = listener.address() as AddressInfo

  return (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init)
}

describe('httpServer', () => {
  afterEach(() => {
    listener?.close()
    listener = undefined
    vi.unstubAllEnvs()
  })

  it('serves health', async () => {
    const request = await serve()

    const res = await request('/api/game/health')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(health)
  })

  describe('routes', () => {
    it('lists its own endpoints with what they do', async () => {
      const request = await serve()

      const res = await request('/api/game/routes')
      const { routes } = await res.json() as { routes: any[] }

      expect(res.status).toBe(200)
      expect(routes.map(route => `${route.method} ${route.path}`)).toEqual([
        'GET /api/game/health',
        'GET /api/game/metrics',
        'GET /api/game/logs',
        'GET /api/game/requests',
        'GET /api/game/routes',
        'GET /api/game/plugins',
      ])
      expect(routes.every(route => route.source === 'engine' && route.summary && route.auth)).toBe(true)
      expect(routes[2].query).toHaveProperty('after')
      expect(routes.some(route => route.devOnly)).toBe(false)
    })

    it('lists routes added to the app afterwards as the game\'s', async () => {
      const request = await serve()
      http.app.post('/api/scores/:id', (_req, res) => void res.end())

      const { routes } = await (await request('/api/game/routes')).json() as { routes: any[] }

      expect(routes.at(-1)).toEqual({ method: 'POST', path: '/api/scores/:id', source: 'game', params: { id: '' }, devOnly: false })
    })

    it('lists the dev endpoints only when they are served', async () => {
      const inspector = { scene: () => null, entities: () => ({}), entity: () => null } as any
      const request = await serve({ inspector })

      const { routes } = await (await request('/api/game/routes')).json() as { routes: any[] }
      const dev = routes.filter(route => route.path.startsWith('/api/game/dev/'))

      expect(dev.map(route => route.path)).toEqual(['/api/game/dev/scene', '/api/game/dev/entities', '/api/game/dev/entities/:id'])
      expect(dev[2].params).toEqual({ id: 'Id of the entity' })
      expect(dev.every(route => route.devOnly)).toBe(true)
      expect(routes.filter(route => !route.path.startsWith('/api/game/dev/')).some(route => route.devOnly)).toBe(false)
    })

    it('is protected like the metrics', async () => {
      const request = await serve({ metrics: { token: 'secret' } })

      expect((await request('/api/game/routes')).status).toBe(401)
      expect((await request('/api/game/routes?token=secret')).status).toBe(200)
    })
  })

  describe('plugins', () => {
    const plugins = [{ package: 'forest', enabled: true, installed: true, version: '1.0.0', declaredPrefabs: [], usedPrefabs: [], runningOnServer: true }]

    it('lists the plugins it is given, asked anew every time', async () => {
      const list = vi.fn(() => plugins)
      const request = await serve({ plugins: list })

      expect(await (await request('/api/game/plugins')).json()).toEqual({ plugins })
      await request('/api/game/plugins')
      expect(list).toHaveBeenCalledTimes(2)
    })

    it('is not found on a server that doesn\'t know its plugins', async () => {
      const request = await serve()

      expect((await request('/api/game/plugins')).status).toBe(404)
    })

    it('is protected like the metrics', async () => {
      const request = await serve({ plugins: () => plugins, metrics: { token: 'secret' } })

      expect((await request('/api/game/plugins')).status).toBe(401)
      expect((await request('/api/game/plugins?token=secret')).status).toBe(200)
    })
  })

  describe('admin token', () => {
    function adminRoute() {
      http.app.post('/api/admin/reset', http.requireAdmin, (_req, res) => void res.json({ reset: true }))
    }

    it('lets localhost through without a token, and nobody else', async () => {
      const request = await serve()
      adminRoute()

      expect((await request('/api/admin/reset', { method: 'POST' })).status).toBe(200)

      // What Express would hand the guard for a request from another machine
      const res = { status: vi.fn().mockReturnThis(), json: vi.fn() }
      const next = vi.fn()
      http.requireAdmin({ headers: {}, socket: { remoteAddress: '203.0.113.9' } } as any, res as any, next)
      expect(res.status).toHaveBeenCalledWith(403)
      expect(res.json).toHaveBeenCalledWith({ error: expect.stringContaining('MAVONENGINE_ADMIN_TOKEN') })
      expect(next).not.toHaveBeenCalled()
    })

    it('wants the token as a bearer header when one is set, also from localhost', async () => {
      const request = await serve({ adminToken: 'secret' })
      adminRoute()
      const post = (headers: Record<string, string> = {}, query = '') => request(`/api/admin/reset${query}`, { method: 'POST', headers })

      expect((await post()).status).toBe(401)
      expect((await post({ Authorization: 'Bearer wrong' })).status).toBe(401)
      expect((await post({ Authorization: 'secret' })).status).toBe(401)
      // Not in the URL, where it would end up in logs
      expect((await post({}, '?token=secret')).status).toBe(401)

      const res = await post({ Authorization: 'Bearer secret' })
      expect(res.status).toBe(200)
      expect(await res.json()).toEqual({ reset: true })
    })

    it('checks a candidate without giving the token away', async () => {
      await serve({ adminToken: 'secret' })
      expect(http.adminToken.configured).toBe(true)
      expect(http.adminToken.matches('secret')).toBe(true)
      expect(http.adminToken.matches('wrong')).toBe(false)
      expect(http.adminToken.matches('')).toBe(false)
      expect(JSON.stringify(http.adminToken)).not.toContain('secret')
      listener?.close()

      await serve()
      expect(http.adminToken.configured).toBe(false)
      expect(http.adminToken.matches('')).toBe(false)
    })

    it('also opens the metrics, next to their own token', async () => {
      const request = await serve({ adminToken: 'admin', metrics: { token: 'metrics' } })
      adminRoute()

      expect((await request('/api/game/metrics')).status).toBe(401)
      expect((await request('/api/game/metrics', { headers: { Authorization: 'Bearer metrics' } })).status).toBe(200)
      expect((await request('/api/game/metrics', { headers: { Authorization: 'Bearer admin' } })).status).toBe(200)
      expect((await request('/api/game/metrics?token=admin')).status).toBe(200)

      // The metrics token reads, it doesn't administer
      expect((await request('/api/admin/reset', { method: 'POST', headers: { Authorization: 'Bearer metrics' } })).status).toBe(401)
    })

    it('turns the metrics on in production by itself', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      const request = await serve({ adminToken: 'admin' })

      expect((await request('/api/game/metrics')).status).toBe(401)
      expect((await request('/api/game/metrics', { headers: { Authorization: 'Bearer admin' } })).status).toBe(200)
    })

    it('says on the routes it guards who may call them, unless they say so themselves', async () => {
      const request = await serve({ adminToken: 'secret' })
      adminRoute()

      const { routes } = await (await request('/api/game/routes', { headers: { Authorization: 'Bearer secret' } })).json() as { routes: any[] }
      const reset = routes.find(route => route.path === '/api/admin/reset')

      expect(reset).toMatchObject({ method: 'POST', source: 'game', auth: 'The server\'s admin token as `Authorization: Bearer <token>`' })
      expect(routes.find(route => route.path === '/api/game/health').auth).toBe('None')

      // Without a token the same route says it is localhost only
      listener?.close()
      const local = await serve()
      adminRoute()
      const listed = await (await local('/api/game/routes')).json() as { routes: any[] }
      expect(listed.routes.find(route => route.path === '/api/admin/reset').auth).toContain('Requests from localhost only')
    })
  })

  it('serves metrics to localhost without a token', async () => {
    const request = await serve()

    const res = await request('/api/game/metrics')

    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(snapshot)
  })

  it('requires the token when one is configured', async () => {
    const request = await serve({ metrics: { token: 'secret' } })

    expect((await request('/api/game/metrics')).status).toBe(401)
    expect((await request('/api/game/metrics?token=wrong')).status).toBe(401)
    expect((await request('/api/game/metrics?token=secret')).status).toBe(200)

    const res = await request('/api/game/metrics', { headers: { Authorization: 'Bearer secret' } })
    expect(res.status).toBe(200)
  })

  it('can be disabled', async () => {
    const request = await serve({ metrics: { enabled: false } })

    expect((await request('/api/game/metrics')).status).toBe(404)
    expect((await request('/api/game/health')).status).toBe(200)
  })

  it('is disabled in production unless a token is set', async () => {
    vi.stubEnv('NODE_ENV', 'production')

    const request = await serve()
    expect((await request('/api/game/metrics')).status).toBe(404)

    listener?.close()

    const withToken = await serve({ metrics: { token: 'secret' } })
    expect((await withToken('/api/game/metrics?token=secret')).status).toBe(200)
  })

  it('serves logs after an id', async () => {
    const logs = new LogBuffer()
    logs.push('info', 'one')
    logs.push('warn', 'two')

    const request = await serve({ logs })

    const all = await (await request('/api/game/logs')).json()
    expect(all.latestId).toBe(2)
    expect(all.entries.map((e: any) => e.message)).toEqual(['one', 'two'])

    const newer = await (await request('/api/game/logs?after=1')).json()
    expect(newer.entries.map((e: any) => e.message)).toEqual(['two'])

    expect((await (await request('/api/game/logs?after=nope')).json()).entries).toHaveLength(2)
  })

  it('protects logs like metrics', async () => {
    const request = await serve({ logs: new LogBuffer(), metrics: { token: 'secret' } })

    expect((await request('/api/game/logs')).status).toBe(401)
    expect((await request('/api/game/logs?token=secret')).status).toBe(200)
  })

  it('404s logs without a buffer', async () => {
    const request = await serve()

    expect((await request('/api/game/logs')).status).toBe(404)
  })

  it('serves recorded requests after an id, protected like metrics', async () => {
    const requests = new RequestLog()
    requests.push({ timestamp: 0, method: 'GET', path: '/one', status: 200, durationMs: 1, bytes: 10, address: null })
    requests.push({ timestamp: 0, method: 'GET', path: '/two', status: 404, durationMs: 1, bytes: 10, address: null })

    const request = await serve({ requests, metrics: { token: 'secret' } })

    expect((await request('/api/game/requests')).status).toBe(401)

    const newer = await (await request('/api/game/requests?after=1&token=secret')).json()
    expect(newer.latestId).toBe(2)
    expect(newer.entries.map((e: any) => e.path)).toEqual(['/two'])
  })

  it('404s requests without a request log', async () => {
    const request = await serve()

    expect((await request('/api/game/requests')).status).toBe(404)
  })

  it('tracks whether metrics were fetched recently', async () => {
    const request = await serve()

    expect(http.metricsClientActive()).toBe(false)

    await request('/api/game/metrics')

    expect(http.metricsClientActive()).toBe(true)
    expect(http.metricsClientActive(Date.now() + METRICS_CLIENT_TIMEOUT_MS + 1)).toBe(false)
  })

  it('does not count rejected metrics requests', async () => {
    const request = await serve({ metrics: { token: 'secret' } })

    await request('/api/game/metrics')

    expect(http.metricsClientActive()).toBe(false)
  })

  describe('dev endpoints', () => {
    function fakeInspector() {
      return {
        scene: vi.fn(() => ({ name: 'Forest' })),
        entities: vi.fn(() => ({ total: 0, entities: [] })),
        entity: vi.fn((id: string) => id === 'rock' ? { id: 'rock' } : null),
      } as any
    }

    it('serves the scene and entities', async () => {
      const inspector = fakeInspector()
      const request = await serve({ inspector })

      expect(http.devEndpointsEnabled).toBe(true)
      expect(await (await request('/api/game/dev/scene')).json()).toEqual({ scene: { name: 'Forest' } })
      expect(await (await request('/api/game/dev/entities/rock')).json()).toEqual({ entity: { id: 'rock' } })
      expect(await (await request('/api/game/dev/entities/nope')).json()).toEqual({ entity: null })

      expect((await request('/api/game/dev/entities?type=Rock&near=1,2,3&radius=5&limit=2')).status).toBe(200)
      expect(inspector.entities).toHaveBeenCalledWith({ type: 'Rock', near: { x: 1, y: 2, z: 3 }, radius: 5, limit: 2 })

      const bad = await request('/api/game/dev/entities?near=1,2')
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ error: 'near must be x,y,z' })
    })

    it('serves the recorded packets and the state sync', async () => {
      const net = new NetRecorder({ enabled: true })
      net.packet('out', 'sv_state', { tick: 1, entities: [] }, { peer: 'p1' })
      net.packet('in', 'command', { type: 'cl_move', sequenceId: 2 }, { peer: 'p1' })
      const request = await serve({ net: { net, syncSnapshot: () => ({ tick: 9 }) as any } })

      const all = await (await request('/api/game/dev/net/packets')).json()
      expect(all).toMatchObject({ enabled: true, latestId: 2, matched: 2, records: [{ type: 'sv_state' }, { type: 'command' }] })

      const filtered = await (await request('/api/game/dev/net/packets?after=1&direction=in&peer=p1&limit=5')).json()
      expect(filtered.records).toMatchObject([{ id: 2, type: 'command', sequenceId: 2 }])

      expect(await (await request('/api/game/dev/net/packets/1')).json()).toMatchObject({ record: { id: 1, payload: { tick: 1, entities: [] } } })
      expect(await (await request('/api/game/dev/net/packets/99')).json()).toEqual({ record: null })
      expect(await (await request('/api/game/dev/net/sync')).json()).toEqual({ tick: 9 })

      const bad = await request('/api/game/dev/net/packets?kind=frame')
      expect(bad.status).toBe(400)
      expect(await bad.json()).toEqual({ error: 'kind must be packet or event' })
    })

    it('does not serve the network debug endpoints in production or without a source', async () => {
      expect((await (await serve({ inspector: fakeInspector() }))('/api/game/dev/net/sync')).status).toBe(404)
      listener?.close()

      vi.stubEnv('NODE_ENV', 'production')
      const request = await serve({ net: { net: new NetRecorder({ enabled: true }), syncSnapshot: () => ({}) as any }, metrics: { token: 'secret' } })
      expect((await request('/api/game/dev/net/sync?token=secret')).status).toBe(404)
      expect((await request('/api/game/dev/net/packets?token=secret')).status).toBe(404)
    })

    it('are not registered without an inspector', async () => {
      const request = await serve()

      expect(http.devEndpointsEnabled).toBe(false)
      expect((await request('/api/game/dev/scene')).status).toBe(404)
    })

    it('are protected like metrics', async () => {
      const request = await serve({ inspector: fakeInspector(), metrics: { token: 'secret' } })

      expect((await request('/api/game/dev/scene')).status).toBe(401)
      expect((await request('/api/game/dev/entities')).status).toBe(401)
      expect((await request('/api/game/dev/scene?token=secret')).status).toBe(200)
    })

    it('follow metrics being turned off', async () => {
      const request = await serve({ inspector: fakeInspector(), metrics: { enabled: false } })

      expect((await request('/api/game/dev/scene')).status).toBe(404)
    })

    it('do not exist in production, even with a valid token', async () => {
      vi.stubEnv('NODE_ENV', 'production')
      const inspector = fakeInspector()

      const request = await serve({ inspector, metrics: { token: 'secret' } })

      expect(http.devEndpointsEnabled).toBe(false)
      // Metrics still work with the token, the dev routes don't
      expect((await request('/api/game/metrics?token=secret')).status).toBe(200)
      expect((await request('/api/game/dev/scene?token=secret')).status).toBe(404)
      expect((await request('/api/game/dev/entities?token=secret')).status).toBe(404)
      expect((await request('/api/game/dev/entities/rock?token=secret')).status).toBe(404)
      expect(inspector.scene).not.toHaveBeenCalled()
    })
  })
})

describe('parseEntityQuery', () => {
  it('ignores empty values and rejects bad numbers', () => {
    expect(parseEntityQuery({})).toEqual({})
    expect(parseEntityQuery({ type: '', limit: '' })).toEqual({})
    expect(parseEntityQuery({ offset: '3' })).toEqual({ offset: 3 })
    expect(parseEntityQuery({ limit: '-1' })).toBe('limit must be a number, at least 0')
    expect(parseEntityQuery({ radius: 'far' })).toBe('radius must be a number, at least 0')
    expect(parseEntityQuery({ near: '1,x,3' })).toBe('near must be x,y,z')
  })
})
