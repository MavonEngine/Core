import type { Server as NodeServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { HttpServerOptions } from '../../../../src/Networking/Server/Http/HttpServer'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import HttpServer from '../../../../src/Networking/Server/Http/HttpServer'

const health = { serverTime: 'now', uptime: 1, players: 0, world: { entities: 0 }, physics: {} }

let dir: string
let http: HttpServer

async function serve(options: HttpServerOptions = {}) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as any
  const metrics = { health: () => health, snapshot: () => ({}) } as any

  http = new HttpServer(logger, metrics, { port: 0, ...options })
  http.start()
  const listener = http.server as NodeServer
  await new Promise(resolve => listener.once('listening', resolve))

  const served = http.serveClient()
  const { port } = listener.address() as AddressInfo

  return {
    served,
    logger,
    request: (path: string, init?: RequestInit) => fetch(`http://127.0.0.1:${port}${path}`, init),
  }
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mavonengine-client-'))
})

afterEach(async () => {
  await new Promise(resolve => http.server?.close(resolve))
  rmSync(dir, { recursive: true, force: true })
})

describe('serveClient', () => {
  it('serves nothing without client options', async () => {
    const { served, request } = await serve()

    expect(served).toBe(false)
    expect((await request('/')).status).toBe(404)
  })

  describe('built client', () => {
    beforeEach(() => {
      mkdirSync(join(dir, 'dist', 'assets'), { recursive: true })
      writeFileSync(join(dir, 'dist', 'index.html'), '<html>game</html>')
      writeFileSync(join(dir, 'dist', 'assets', 'app.js'), 'console.log(1)')
    })

    it('serves files from <root>/dist', async () => {
      const { served, request } = await serve({ client: { root: dir } })

      expect(served).toBe(true)
      expect(await (await request('/assets/app.js')).text()).toBe('console.log(1)')
    })

    it('falls back to index.html for page routes', async () => {
      const { request } = await serve({ client: { root: dir } })

      const res = await request('/lobby/42', { headers: { Accept: 'text/html' } })

      expect(res.status).toBe(200)
      expect(await res.text()).toBe('<html>game</html>')
    })

    it('leaves missing assets and api routes alone', async () => {
      const { request } = await serve({ client: { root: dir } })

      expect((await request('/assets/missing.js')).status).toBe(404)
      expect((await request('/src/main.ts', { headers: { Accept: 'text/html' } })).status).toBe(404)
      expect((await request('/api/nope', { headers: { Accept: 'text/html' } })).status).toBe(404)
      expect(await (await request('/api/game/health')).json()).toEqual(health)
    })

    it('uses a custom dist directory', async () => {
      mkdirSync(join(dir, 'out'))
      writeFileSync(join(dir, 'out', 'index.html'), '<html>out</html>')
      const { request } = await serve({ client: { root: dir, dist: join(dir, 'out') } })

      expect(await (await request('/')).text()).toBe('<html>out</html>')
    })
  })

  it('warns when the client has not been built', async () => {
    const { served, logger } = await serve({ client: { root: dir } })

    expect(served).toBe(false)
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('No built client'))
  })

  it('serves the client source through Vite in dev mode', async () => {
    writeFileSync(join(dir, 'index.html'), '<html><body><script type="module" src="/main.js"></script></body></html>')
    writeFileSync(join(dir, 'main.js'), 'export const answer = 42')
    const { served, request } = await serve({ client: { root: dir, dev: true } })

    expect(served).toBe(true)

    const page = await (await request('/', { headers: { Accept: 'text/html' } })).text()
    expect(page).toContain('/@vite/client')

    expect(await (await request('/main.js')).text()).toContain('answer = 42')
    expect(await (await request('/api/game/health')).json()).toEqual(health)
  }, 20000)
})
