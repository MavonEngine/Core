import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import { parseMcpArgs } from '../src/commands/mcp'
import { compareEntities } from '../src/mcp/clientTools'
import { writeMcpConfig } from '../src/mcp/config'
import GameServerClient from '../src/mcp/GameServerClient'
import { createMcpServer } from '../src/mcp/server'

const metrics = {
  schemaVersion: 1,
  tickRate: 30,
  players: [{ id: 'p1', displayName: 'Ada' }],
  cpu: { current: 12, avg1s: 11, avg10s: 10, avg60s: 9, history: [{ cpuPercentage: 1 }] },
  bandwidth: { sentPerSecond: 100, receivedPerSecond: 50, history: [{ sent: 1 }] },
  tick: { budgetMs: 33.33, latest: { durationMs: 2 }, history: [{ durationMs: 2 }] },
}

type Route = (url: URL) => Response | undefined

/** A fetch that answers from `routes` and 404s anything else, recording the URLs asked for */
function fakeFetch(routes: Record<string, unknown | Route>) {
  const calls: URL[] = []
  const fetch = (async (input: URL) => {
    const url = new URL(input)
    calls.push(url)
    const route = routes[url.pathname]
    if (route === undefined)
      return new Response('', { status: 404 })
    const res = typeof route === 'function' ? (route as Route)(url) : Response.json(route)
    return res ?? new Response('', { status: 404 })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

async function connect(routes: Record<string, unknown | Route>, url = 'http://localhost:8050') {
  const { fetch, calls } = fakeFetch(routes)
  const server = createMcpServer(new GameServerClient({ url, fetch }))
  const client = new Client({ name: 'test', version: '0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])

  async function call(name: string, args: Record<string, unknown> = {}) {
    const result = await client.callTool({ name, arguments: args }) as { isError?: boolean, content: { text: string }[] }
    const text = result.content[0]!.text
    return { isError: !!result.isError, text, data: result.isError ? undefined : JSON.parse(text) }
  }

  return { client, call, calls }
}

describe('mcp server', () => {
  it('lists read-only tools', async () => {
    const { client } = await connect({})

    const { tools } = await client.listTools()
    expect(tools.map(t => t.name).sort()).toEqual([
      'client_entities',
      'client_entity',
      'client_logs',
      'client_network',
      'client_scene',
      'client_screenshot',
      'client_status',
      'client_trace',
      'compare_entity',
      'get_entity',
      'get_scene',
      'list_clients',
      'list_entities',
      'list_players',
      'recent_logs',
      'recent_requests',
      'server_metrics',
      'server_status',
    ])
    expect(tools.every(t => t.annotations?.readOnlyHint)).toBe(true)
  })

  it('summarizes the status without history', async () => {
    const { call } = await connect({ '/api/game/metrics': metrics })

    const { data } = await call('server_status')
    expect(data).toMatchObject({ server: 'http://localhost:8050/', tickRate: 30, players: 1, cpu: { current: 12 }, tick: { budgetMs: 33.33 } })
    expect(data.cpu.history).toBeUndefined()
    expect(data.tick.history).toBeUndefined()
  })

  it('includes metrics history only when asked', async () => {
    const { call } = await connect({ '/api/game/metrics': metrics })

    expect((await call('server_metrics')).data.cpu.history).toBeUndefined()
    expect((await call('server_metrics', { includeHistory: true })).data.cpu.history).toHaveLength(1)
    expect((await call('list_players')).data).toEqual(metrics.players)
  })

  it('reads the scene and can leave out its objects', async () => {
    const scene = { name: 'Forest', objects: [{ id: 'a' }, { id: 'b' }] }
    const { call } = await connect({ '/api/game/dev/scene': { scene } })

    expect((await call('get_scene')).data).toEqual(scene)
    expect((await call('get_scene', { includeObjects: false })).data).toEqual({ name: 'Forest', objectCount: 2 })
  })

  it('says when no scene is loaded', async () => {
    const { call } = await connect({ '/api/game/dev/scene': { scene: null } })

    expect((await call('get_scene')).data).toMatchObject({ scene: null })
  })

  it('passes entity filters to the server', async () => {
    const { call, calls } = await connect({ '/api/game/dev/entities': { total: 0, entities: [] } })

    await call('list_entities', { type: 'Rock', near: { x: 1, y: 2, z: 3 }, radius: 10, limit: 5 })

    const params = Object.fromEntries(calls[0]!.searchParams)
    expect(params).toEqual({ type: 'Rock', near: '1,2,3', radius: '10', limit: '5', offset: '0' })
  })

  it('gets one entity and explains a missing one', async () => {
    const { call } = await connect({
      '/api/game/dev/entities/rock%201': { entity: { id: 'rock 1' } },
      '/api/game/dev/entities/nope': { entity: null },
    })

    expect((await call('get_entity', { id: 'rock 1' })).data).toEqual({ id: 'rock 1' })

    const missing = await call('get_entity', { id: 'nope' })
    expect(missing.isError).toBe(true)
    expect(missing.text).toContain('No entity with id "nope"')
  })

  it('explains that the dev tools need a development server', async () => {
    const { call } = await connect({ '/api/game/metrics': metrics })

    for (const [tool, args] of [['get_scene', {}], ['list_entities', {}], ['get_entity', { id: 'x' }]] as const) {
      const result = await call(tool, args)
      expect(result.isError).toBe(true)
      expect(result.text).toContain('NODE_ENV=production')
    }
  })

  it('filters logs by level and text, keeping the newest', async () => {
    const entries = [
      { id: 1, timestamp: 0, level: 'info', message: 'Server started' },
      { id: 2, timestamp: 0, level: 'warn', message: 'Slow tick' },
      { id: 3, timestamp: 0, level: 'error', message: 'Player crashed' },
      { id: 4, timestamp: 0, level: 'debug', message: 'Player moved' },
    ]
    const { call, calls } = await connect({ '/api/game/logs': { entries, latestId: 4 } })

    const warn = (await call('recent_logs', { level: 'warn' })).data
    expect(warn.entries.map((e: any) => e.id)).toEqual([2, 3])
    expect(warn.latestId).toBe(4)
    expect(warn.entries[0].time).toBe('1970-01-01T00:00:00.000Z')

    expect((await call('recent_logs', { contains: 'player', limit: 1 })).data.entries.map((e: any) => e.id)).toEqual([4])

    await call('recent_logs', { afterId: 3 })
    expect(calls.at(-1)!.searchParams.get('after')).toBe('3')
  })

  it('filters requests', async () => {
    const entries = [
      { id: 1, path: '/api/game/health', status: 200 },
      { id: 2, path: '/assets/a.png', status: 404 },
      { id: 3, path: '/api/game/metrics', status: 500 },
    ]
    const { call } = await connect({ '/api/game/requests': { entries, latestId: 3 } })

    expect((await call('recent_requests', { minStatus: 400 })).data.entries.map((e: any) => e.id)).toEqual([2, 3])
    expect((await call('recent_requests', { pathContains: '/api/' })).data.entries.map((e: any) => e.id)).toEqual([1, 3])
  })

  it('turns auth and connection failures into tool errors', async () => {
    const { call } = await connect({ '/api/game/metrics': () => new Response('', { status: 401 }) })
    expect((await call('server_status')).text).toContain('--token')

    const down = createMcpServer(new GameServerClient({
      url: 'http://localhost:1',
      fetch: (async () => { throw new Error('ECONNREFUSED') }) as unknown as typeof fetch,
    }))
    const client = new Client({ name: 'test', version: '0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([down.connect(a), client.connect(b)])
    const result = await client.callTool({ name: 'server_status', arguments: {} }) as { isError: boolean, content: { text: string }[] }
    expect(result.isError).toBe(true)
    expect(result.content[0]!.text).toContain('Is it running?')
  })

  it('resolves paths under a base URL with a prefix', async () => {
    const { call, calls } = await connect({ '/game/api/game/metrics': metrics }, 'http://example.com/game')

    expect((await call('server_status')).isError).toBe(false)
    expect(calls[0]!.pathname).toBe('/game/api/game/metrics')
  })

  it('sends the token as a bearer header', async () => {
    let auth: string | null = null
    const fetch = (async (_url: URL, init: RequestInit) => {
      auth = new Headers(init.headers).get('authorization')
      return Response.json(metrics)
    }) as unknown as typeof globalThis.fetch

    await new GameServerClient({ url: 'http://localhost:8050', token: 'secret', fetch }).metrics()
    expect(auth).toBe('Bearer secret')
  })
})

describe('client tools', () => {
  const bridge = '/__mavonengine/clients'

  it('lists the open tabs', async () => {
    const { call } = await connect({ [bridge]: { clients: [{ id: 'tab1', playerId: 'p1' }] } })

    expect((await call('list_clients')).data).toEqual({ devServer: 'http://localhost:8050/', clients: [{ id: 'tab1', playerId: 'p1' }] })
    const empty = await connect({ [bridge]: { clients: [] } })
    expect((await empty.call('list_clients')).data.note).toContain('No game tab is open')
  })

  it('asks the auto tab unless a client id is given, passing filters', async () => {
    const { call, calls } = await connect({
      [`${bridge}/auto/status`]: { fps: 60 },
      [`${bridge}/tab%202/entities`]: { total: 0, entities: [] },
    })

    expect((await call('client_status')).data).toEqual({ fps: 60 })

    await call('client_entities', { clientId: 'tab 2', type: 'Rock', near: { x: 1, y: 2, z: 3 }, limit: 5 })
    expect(Object.fromEntries(calls.at(-1)!.searchParams)).toEqual({ type: 'Rock', near: '1,2,3', limit: '5', offset: '0' })
  })

  it('filters client logs by console level', async () => {
    const entries = [
      { id: 1, timestamp: 0, level: 'log', message: 'hello' },
      { id: 2, timestamp: 0, level: 'warn', message: 'careful' },
      { id: 3, timestamp: 0, level: 'debug', message: 'noise' },
      { id: 4, timestamp: 0, level: 'error', message: 'Uncaught TypeError' },
    ]
    const { call } = await connect({ [`${bridge}/auto/logs`]: { entries, latestId: 4 } })

    expect((await call('client_logs', { level: 'info' })).data.entries.map((e: any) => e.id)).toEqual([1, 2, 4])
    expect((await call('client_logs', { contains: 'typeerror' })).data.entries.map((e: any) => e.id)).toEqual([4])
  })

  it('returns a screenshot as an image', async () => {
    const { client } = await connect({ [`${bridge}/auto/screenshot`]: { mimeType: 'image/jpeg', width: 640, height: 360, data: 'QUJD' } })

    const result = await client.callTool({ name: 'client_screenshot', arguments: { maxWidth: 640 } }) as any
    expect(result.content[0]).toEqual({ type: 'image', data: 'QUJD', mimeType: 'image/jpeg' })
    expect(result.content[1].text).toBe('640x360 image/jpeg')
  })

  it('compares an entity on the server and a client', async () => {
    const at = (x: number) => ({ x, y: 0, z: 0 })
    const { call } = await connect({
      '/api/game/dev/entities/p1': { entity: { id: 'p1', position: at(10), rotation: at(0), scale: at(1), serialized: { id: 'p1', health: 90, $typeName: 'Player' } } },
      [`${bridge}/auto/entity`]: { entity: { id: 'localPlayer', position: at(10.5), rotation: at(0), scale: at(1), serialized: { id: 'localPlayer', health: 100, $typeName: 'Player' } } },
    })

    const { data } = await call('compare_entity', { id: 'p1' })
    expect(data.clientId).toBe('localPlayer')
    expect(data.positionDelta).toEqual({ x: 0.5, y: 0, z: 0, length: 0.5 })
    expect(data.differentFields).toEqual([{ field: 'health', server: 90, client: 100 }])
    expect(data.server.serialized).toBeUndefined()
  })

  it('explains an entity that exists on one side only', () => {
    const entity = { id: 'a', position: { x: 0, y: 0, z: 0 }, rotation: { x: 0, y: 0, z: 0 }, scale: { x: 1, y: 1, z: 1 } }

    expect(compareEntities('a', entity, null).note).toContain('Only the server has it')
    expect(compareEntities('a', null, entity).note).toContain('Only the client has it')
    expect(compareEntities('a', null, null).note).toBe('Neither side has this entity')
  })

  it('explains a dev server without the bridge, and passes on bridge errors', async () => {
    const { call } = await connect({
      [bridge]: () => new Response('<html></html>', { headers: { 'content-type': 'text/html' } }),
      [`${bridge}/auto/status`]: () => Response.json({ error: '2 game tabs are open, pick one by id: a, b' }, { status: 409 }),
    })

    const noBridge = await call('list_clients')
    expect(noBridge.isError).toBe(true)
    expect(noBridge.text).toContain('--client-url')

    const ambiguous = await call('client_status')
    expect(ambiguous.isError).toBe(true)
    expect(ambiguous.text).toBe('2 game tabs are open, pick one by id: a, b')
  })

  it('asks a separate client URL when given', async () => {
    const { fetch, calls } = fakeFetch({ '/vite/__mavonengine/clients': { clients: [] } })
    const gameServer = new GameServerClient({ url: 'http://localhost:8050', clientUrl: 'http://localhost:5173/vite', fetch })

    await gameServer.clients()
    expect(calls[0]!.href).toBe('http://localhost:5173/vite/__mavonengine/clients')
  })
})

describe('parseMcpArgs', () => {
  it('builds the server URL from host and port, or takes --url', () => {
    const fromPort = parseMcpArgs(['--port', '9000'], {})
    expect(fromPort !== 'help' && fromPort.client.url).toBe('http://localhost:9000/')

    const fromIpv6 = parseMcpArgs(['--host', '::1'], {})
    expect(fromIpv6 !== 'help' && fromIpv6.client.url).toBe('http://[::1]:8050/')

    const fromUrl = parseMcpArgs(['--url', 'https://game.example.com/prefix'], {})
    expect(fromUrl !== 'help' && fromUrl.client.url).toBe('https://game.example.com/prefix/')
    expect(fromUrl !== 'help' && fromUrl.client.clientUrl).toBe('https://game.example.com/prefix/')

    const vite = parseMcpArgs(['--client-url', 'http://localhost:5173'], {})
    expect(vite !== 'help' && vite.client.clientUrl).toBe('http://localhost:5173/')
    expect(() => parseMcpArgs(['--client-url', 'nope'], {})).toThrow('Invalid --client-url')
  })

  it('rejects bad input and shows help', () => {
    expect(() => parseMcpArgs(['--port', '0'], {})).toThrow('--port')
    expect(() => parseMcpArgs(['--url', 'nope'], {})).toThrow('Invalid --url')
    expect(() => parseMcpArgs(['--bogus'], {})).toThrow()
    expect(parseMcpArgs(['-h'], {})).toBe('help')
  })
})

describe('writeMcpConfig', () => {
  let dir: string
  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  function setup() {
    dir = mkdtempSync(join(tmpdir(), 'mavonengine-mcp-'))
    return join(dir, '.mcp.json')
  }

  it('writes a new .mcp.json', () => {
    const file = setup()

    expect(writeMcpConfig(dir)).toBe(true)
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      mcpServers: { mavonengine: { command: 'npx', args: ['-y', '@mavonengine/cli', 'mcp'] } },
    })
  })

  it('keeps other servers and an existing entry', () => {
    const file = setup()
    writeFileSync(file, JSON.stringify({ mcpServers: { other: { command: 'x' } } }))

    expect(writeMcpConfig(dir)).toBe(true)
    expect(Object.keys(JSON.parse(readFileSync(file, 'utf8')).mcpServers)).toEqual(['other', 'mavonengine'])

    writeFileSync(file, JSON.stringify({ mcpServers: { mavonengine: { command: 'custom' } } }))
    expect(writeMcpConfig(dir)).toBe(false)
    expect(JSON.parse(readFileSync(file, 'utf8')).mcpServers.mavonengine.command).toBe('custom')
  })

  it('leaves a file it cannot read alone', () => {
    const file = setup()
    writeFileSync(file, '{ not json')

    expect(writeMcpConfig(dir)).toBe(false)
    expect(readFileSync(file, 'utf8')).toBe('{ not json')
  })
})
