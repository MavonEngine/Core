import type { Server as NodeServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { HttpServerOptions } from '../../../../src/Networking/Server/Http/HttpServer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HttpServer, { METRICS_CLIENT_TIMEOUT_MS } from '../../../../src/Networking/Server/Http/HttpServer'
import LogBuffer from '../../../../src/Networking/Server/Stats/LogBuffer'

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
})
