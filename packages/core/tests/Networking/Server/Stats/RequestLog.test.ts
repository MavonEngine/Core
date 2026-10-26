import type { AddressInfo } from 'node:net'
import { createServer, request as httpRequest } from 'node:http'
import { afterEach, describe, expect, it } from 'vitest'
import RequestLog from '../../../../src/Networking/Server/Stats/RequestLog'

let server: ReturnType<typeof createServer> | undefined

async function listen(handler: Parameters<typeof createServer>[0]) {
  server = createServer(handler)
  const log = new RequestLog()
  log.attach(server)

  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', resolve))
  const { port } = server.address() as AddressInfo

  return { log, port }
}

/** Ask for a WebSocket upgrade and resolve with the status line, or null if the connection closes first */
function upgrade(port: number, path: string) {
  return new Promise<string | null>((resolve) => {
    const req = httpRequest({ port, host: '127.0.0.1', path, headers: { Connection: 'Upgrade', Upgrade: 'websocket' } })
    req.on('upgrade', (res, socket) => {
      socket.destroy()
      resolve(`${res.statusCode}`)
    })
    req.on('error', () => resolve(null))
    req.on('close', () => resolve(null))
    req.end()
  })
}

/** Lets the server side 'close' events run */
const settle = () => new Promise(resolve => setTimeout(resolve, 20))

describe('requestLog', () => {
  afterEach(() => {
    server?.closeAllConnections()
    server?.close()
    server = undefined
  })

  it('records requests with status, size and timing, without the query string', async () => {
    const { log, port } = await listen((req, res) => {
      res.statusCode = req.url!.startsWith('/missing') ? 404 : 200
      res.end('hello')
    })

    await (await fetch(`http://127.0.0.1:${port}/index.html?token=secret`)).text()
    await (await fetch(`http://127.0.0.1:${port}/missing`, { method: 'POST' })).text()
    await settle()

    const { entries, latestId } = log.since()
    expect(latestId).toBe(2)
    expect(entries.map(e => [e.method, e.path, e.status])).toEqual([
      ['GET', '/index.html', 200],
      ['POST', '/missing', 404],
    ])
    expect(entries[0].bytes).toBeGreaterThan('hello'.length)
    expect(entries[0].durationMs).toBeGreaterThanOrEqual(0)
    expect(entries[0].address).toContain('127.0.0.1')
  })

  it('skips the dashboard\'s own polling', async () => {
    const { log, port } = await listen((_req, res) => res.end())

    await fetch(`http://127.0.0.1:${port}/api/game/metrics`)
    await fetch(`http://127.0.0.1:${port}/api/game/logs?after=3`)
    await fetch(`http://127.0.0.1:${port}/api/game/requests`)
    await fetch(`http://127.0.0.1:${port}/api/game/health`)
    await settle()

    expect(log.since().entries.map(e => e.path)).toEqual(['/api/game/health'])
  })

  it('records WebSocket upgrades with the handshake status', async () => {
    const { log, port } = await listen((_req, res) => res.end())
    server!.on('upgrade', (_req, socket) => {
      socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n')
    })

    expect(await upgrade(port, '/hmr?token=abc')).toBe('101')
    await settle()

    expect(log.since().entries).toEqual([expect.objectContaining({ method: 'WS', path: '/hmr', status: 101 })])
  })

  it('closes upgrades nothing else handles, like Node does without listeners', async () => {
    const { log, port } = await listen((_req, res) => res.end())

    expect(await upgrade(port, '/ws')).toBeNull()
    await settle()

    expect(log.since().entries).toEqual([expect.objectContaining({ method: 'WS', path: '/ws', status: null })])
  })

  it('returns only entries after the given id and drops the oldest past capacity', () => {
    const log = new RequestLog(2)
    for (const path of ['/a', '/b', '/c'])
      log.push({ timestamp: 0, method: 'GET', path, status: 200, durationMs: 1, bytes: 0, address: null })

    expect(log.since().entries.map(e => e.id)).toEqual([2, 3])
    expect(log.since(2)).toEqual({ entries: [expect.objectContaining({ path: '/c' })], latestId: 3 })
  })
})
