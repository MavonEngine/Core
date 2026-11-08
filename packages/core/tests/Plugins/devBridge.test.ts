import type { AddressInfo } from 'node:net'
import type { ViteDevServer } from 'vite'
import type { BridgeClientInfo, BridgeRequest } from '../../src/Dev/bridgeProtocol'
import type { BridgeSocketClient, BridgeSocketServer } from '../../src/Plugins/devBridge'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { join } from 'node:path'
import { build, createServer } from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_ANNOUNCE, BRIDGE_HELLO, BRIDGE_REQUEST, BRIDGE_RESPONSE } from '../../src/Dev/bridgeProtocol'
import { DevBridgeHub, handleBridgeRequest } from '../../src/Plugins/devBridge'
import { mavonEnginePlugins, VIRTUAL_DEV_BRIDGE_ID } from '../../src/Plugins/vite'
import { tempProject, writeFile } from './fixtures'

function tabInfo(id: string, extra: Partial<BridgeClientInfo> = {}): BridgeClientInfo {
  return { id, url: `http://localhost/${id}`, title: 'Game', userAgent: 'test', playerId: null, editor: false, visible: true, focused: true, fps: 60, ...extra }
}

/** A Vite WebSocket server stand-in, with tabs that answer requests through `respond` */
function fakeSocketServer() {
  const listeners = new Map<string, (data: any, client: BridgeSocketClient) => void>()
  const broadcasts: string[] = []

  const ws: BridgeSocketServer & { hello(info: BridgeClientInfo, client: BridgeSocketClient): void } = {
    on: (event, listener) => void listeners.set(event, listener),
    send: event => void broadcasts.push(event),
    hello: (info, client) => listeners.get(BRIDGE_HELLO)!(info, client),
  }

  function connect(info: BridgeClientInfo, respond?: (request: BridgeRequest) => unknown) {
    const client: BridgeSocketClient = {
      send: (event, payload) => {
        const request = payload as BridgeRequest
        if (event !== BRIDGE_REQUEST || !respond)
          return
        queueMicrotask(() => {
          try {
            const data = request.query === 'info' ? info : respond(request)
            listeners.get(BRIDGE_RESPONSE)!({ requestId: request.requestId, ok: true, data }, client)
          }
          catch (err) {
            listeners.get(BRIDGE_RESPONSE)!({ requestId: request.requestId, ok: false, error: (err as Error).message }, client)
          }
        })
      },
    }
    listeners.get(BRIDGE_HELLO)!(info, client)
    return { close: () => listeners.get('vite:client:disconnect')!(undefined, client) }
  }

  return { ws, connect, broadcasts }
}

describe('devBridgeHub', () => {
  it('asks a tab and returns its answer', async () => {
    const { ws, connect } = fakeSocketServer()
    const hub = new DevBridgeHub(ws)
    connect(tabInfo('a'), request => ({ query: request.query, params: request.params }))

    expect(await hub.ask('a', 'status', { x: '1' })).toEqual({ query: 'status', params: { x: '1' } })
  })

  it('turns a failed query into an error', async () => {
    const { ws, connect } = fakeSocketServer()
    const hub = new DevBridgeHub(ws)
    connect(tabInfo('a'), () => {
      throw new Error('No game is running')
    })

    await expect(hub.ask('a', 'status', {})).rejects.toMatchObject({ message: 'No game is running', status: 422 })
  })

  it('times out when the tab does not answer', async () => {
    const { ws, connect } = fakeSocketServer()
    const hub = new DevBridgeHub(ws, 20)
    connect(tabInfo('a'))

    await expect(hub.ask('a', 'logs', {})).rejects.toMatchObject({ status: 504 })
  })

  it('picks the only tab, or the only player tab, for auto', () => {
    const { ws, connect } = fakeSocketServer()
    const hub = new DevBridgeHub(ws)

    expect(() => hub.resolve('auto')).toThrow('No game tab is open')

    connect(tabInfo('editor', { editor: true }))
    expect(hub.resolve('auto')).toBe('editor')

    connect(tabInfo('player'))
    expect(hub.resolve('auto')).toBe('player')

    connect(tabInfo('second'))
    expect(() => hub.resolve('auto')).toThrow('3 game tabs are open')
    expect(() => hub.resolve('nope')).toThrow('No open game tab with id nope')
  })

  it('forgets a tab when its socket closes, and keeps it across a reload', () => {
    const { ws, connect } = fakeSocketServer()
    const hub = new DevBridgeHub(ws)

    const first = connect(tabInfo('a'))
    const reloaded = connect(tabInfo('a'))
    expect(hub.size).toBe(1)

    // The old socket closing doesn't remove the reloaded tab
    first.close()
    expect(hub.size).toBe(1)

    reloaded.close()
    expect(hub.size).toBe(0)
  })

  it('lists tabs with their current info, asking tabs to announce themselves when it knows none', async () => {
    const { ws, connect, broadcasts } = fakeSocketServer()
    const hub = new DevBridgeHub(ws)

    expect(await hub.list()).toEqual([])
    expect(broadcasts).toEqual([BRIDGE_ANNOUNCE])

    connect(tabInfo('a', { fps: 30 }), () => null)
    const [tab] = await hub.list()
    expect(tab).toMatchObject({ id: 'a', fps: 30 })
    expect(tab!.connectedFor).toBe(0)
  })
})

describe('handleBridgeRequest', () => {
  let listener: ReturnType<typeof createHttpServer> | undefined
  afterEach(() => listener?.close())

  async function serve(env: Record<string, string | undefined> = {}) {
    const { ws, connect } = fakeSocketServer()
    const hub = new DevBridgeHub(ws)
    listener = createHttpServer((req, res) => {
      if (!handleBridgeRequest(hub, req, res, env)) {
        res.statusCode = 418
        res.end()
      }
    })
    await new Promise<void>(resolve => listener!.listen(0, '127.0.0.1', resolve))
    const base = `http://127.0.0.1:${(listener.address() as AddressInfo).port}`
    return { connect, request: (path: string, init?: RequestInit) => fetch(`${base}${path}`, init) }
  }

  it('lists tabs and forwards queries with their parameters', async () => {
    const { connect, request } = await serve()
    connect(tabInfo('a'), r => ({ query: r.query, params: r.params }))

    const list = await (await request('/__mavonengine/clients')).json()
    expect(list.clients.map((c: any) => c.id)).toEqual(['a'])

    const res = await request('/__mavonengine/clients/auto/entities?type=Rock&near=1,2,3')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ query: 'entities', params: { type: 'Rock', near: '1,2,3' } })
  })

  it('maps errors to statuses', async () => {
    const { request } = await serve()

    expect((await request('/__mavonengine/clients/auto/status')).status).toBe(404)
    const unknown = await request('/__mavonengine/clients/a/bogus')
    expect(unknown.status).toBe(400)
    expect((await unknown.json()).error).toContain('Unknown query bogus')
  })

  it('leaves other paths alone', async () => {
    const { request } = await serve()

    expect((await request('/somewhere')).status).toBe(418)
    expect((await request('/__mavonengine/clients', { method: 'POST' })).status).toBe(418)
  })

  it('requires the token when MAVONENGINE_METRICS_TOKEN is set, and does not pass it on', async () => {
    const { connect, request } = await serve({ MAVONENGINE_METRICS_TOKEN: 'secret' })
    connect(tabInfo('a'), r => r.params)

    expect((await request('/__mavonengine/clients')).status).toBe(401)
    expect((await request('/__mavonengine/clients?token=wrong')).status).toBe(401)

    const res = await request('/__mavonengine/clients/a/logs?after=2', { headers: { Authorization: 'Bearer secret' } })
    expect(await res.json()).toEqual({ after: '2' })
    expect(await (await request('/__mavonengine/clients/a/logs?token=secret')).json()).toEqual({})
  })
})

describe('the vite plugin', () => {
  let root: string
  let vite: ViteDevServer | undefined
  let http: ReturnType<typeof createHttpServer> | undefined

  beforeEach(() => {
    root = tempProject()
    writeFile(join(root, 'client', 'index.html'), '<html><head></head><body><script type="module" src="./main.js"></script></body></html>')
    writeFile(join(root, 'client', 'main.js'), 'window.started = true\n')
  })

  afterEach(async () => {
    await new Promise(resolve => http ? http.close(resolve) : resolve(undefined))
    await vite?.close()
    http = undefined
    vite = undefined
    rmSync(root, { recursive: true, force: true })
  })

  async function start(options: Parameters<typeof mavonEnginePlugins>[0] = {}) {
    http = createHttpServer()
    vite = await createServer({
      root: join(root, 'client'),
      logLevel: 'silent',
      configFile: false,
      plugins: [mavonEnginePlugins(options)],
      server: { middlewareMode: true, hmr: { server: http }, watch: null },
      optimizeDeps: { noDiscovery: true },
      appType: 'spa',
      // Like the template in this repository: core from its source
      resolve: { alias: { '@mavonengine/core': join(import.meta.dirname, '../../src') } },
    })
    http.on('request', vite.middlewares)
    await new Promise<void>(resolve => http!.listen(0, '127.0.0.1', resolve))
    return `127.0.0.1:${(http.address() as AddressInfo).port}`
  }

  it('injects the bridge into the page and serves its module in dev', async () => {
    const host = await start()

    const html = await (await fetch(`http://${host}/`)).text()
    expect(html).toContain(`<script type="module" src="/@id/__x00__${VIRTUAL_DEV_BRIDGE_ID}"></script>`)
    expect(html.indexOf(VIRTUAL_DEV_BRIDGE_ID)).toBeLessThan(html.indexOf('main.js'))

    const result = await vite!.transformRequest(VIRTUAL_DEV_BRIDGE_ID)
    expect(result?.code).toContain('startDevBridge')
  })

  it('serves an empty bridge when core cannot be resolved', async () => {
    http = createHttpServer()
    vite = await createServer({
      root: join(root, 'client'),
      logLevel: 'silent',
      configFile: false,
      plugins: [mavonEnginePlugins()],
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true },
    })

    const result = await vite.transformRequest(VIRTUAL_DEV_BRIDGE_ID)
    expect(result?.code).not.toContain('startDevBridge')
  })

  it('can be turned off', async () => {
    const host = await start({ devBridge: false })

    expect(await (await fetch(`http://${host}/`)).text()).not.toContain(VIRTUAL_DEV_BRIDGE_ID)
    // Vite's SPA fallback answers with the page instead
    expect((await fetch(`http://${host}/__mavonengine/clients`)).headers.get('content-type')).not.toContain('json')
  })

  it('relays queries to a tab over the HMR WebSocket', async () => {
    const host = await start()

    // A tab, speaking Vite's HMR protocol like the injected module does
    const socket = new WebSocket(`ws://${host}/?token=${vite!.config.webSocketToken}`, 'vite-hmr')
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve)
      socket.addEventListener('error', reject)
    })
    const send = (event: string, data: unknown) => socket.send(JSON.stringify({ type: 'custom', event, data }))
    socket.addEventListener('message', (message) => {
      const payload = JSON.parse(String(message.data))
      if (payload.type === 'custom' && payload.event === BRIDGE_REQUEST) {
        const request = payload.data as BridgeRequest
        send(BRIDGE_RESPONSE, { requestId: request.requestId, ok: true, data: request.query === 'info' ? tabInfo('tab-1') : { answered: request.query } })
      }
    })
    send(BRIDGE_HELLO, tabInfo('tab-1'))

    await vi.waitFor(async () => {
      const { clients } = await (await fetch(`http://${host}/__mavonengine/clients`)).json()
      expect(clients.map((c: any) => c.id)).toEqual(['tab-1'])
    })
    expect(await (await fetch(`http://${host}/__mavonengine/clients/auto/status`)).json()).toEqual({ answered: 'status' })

    socket.close()
    await new Promise(resolve => socket.addEventListener('close', resolve))
    await vi.waitFor(async () => {
      const { clients } = await (await fetch(`http://${host}/__mavonengine/clients`)).json()
      expect(clients).toEqual([])
    }, { timeout: 3000 })
    expect((await fetch(`http://${host}/__mavonengine/clients/auto/status`)).status).toBe(404)
  })

  it('leaves the bridge out of a build', async () => {
    const outDir = join(root, 'client', 'dist')
    await build({ root: join(root, 'client'), logLevel: 'silent', configFile: false, plugins: [mavonEnginePlugins()], build: { outDir, minify: false } })

    expect(readFileSync(join(outDir, 'index.html'), 'utf8')).not.toContain('dev-bridge')
    const assets = join(outDir, 'assets')
    const js = existsSync(assets) ? readdirSync(assets).map(f => readFileSync(join(assets, f), 'utf8')).join('\n') : ''
    expect(js).not.toContain('startDevBridge')
  })
})
