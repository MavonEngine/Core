import type { Server as NodeServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { HttpServerOptions } from '../../../../src/Networking/Server/Http/HttpServer'
import { afterEach, describe, expect, it, vi } from 'vitest'
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
