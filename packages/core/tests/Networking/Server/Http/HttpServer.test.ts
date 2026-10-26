import type { Server as NodeServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { HttpServerOptions } from '../../../../src/Networking/Server/Http/HttpServer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import HttpServer from '../../../../src/Networking/Server/Http/HttpServer'

const health = { serverTime: 'now', uptime: 1, players: 0, world: { entities: 0 }, physics: {} }
const snapshot = { schemaVersion: 1, players: [] }

let listener: NodeServer | undefined

async function serve(options: HttpServerOptions = {}) {
  const logger = { info: vi.fn() } as any
  const metrics = { health: () => health, snapshot: () => snapshot } as any

  const http = new HttpServer(logger, metrics, options)

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
})
