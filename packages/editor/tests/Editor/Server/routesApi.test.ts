// @vitest-environment jsdom

import type { HttpRouteInfo } from '../../../src/Editor/Server/routesApi'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fetchRoutes, groupRoutes, SERVER_URL_KEY } from '../../../src/Editor/Server/routesApi'

function answer(status: number, body: unknown, contentType = 'application/json') {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } }))
}

const route = (overrides: Partial<HttpRouteInfo>): HttpRouteInfo => ({ method: 'GET', path: '/', source: 'game', params: {}, devOnly: false, ...overrides })

describe('routesApi', () => {
  afterEach(() => {
    localStorage.clear()
  })

  it('asks the origin of the page', async () => {
    const fetchFn = answer(200, { routes: [route({ path: '/api/scores' })] })

    expect(await fetchRoutes(fetchFn)).toEqual([route({ path: '/api/scores' })])
    expect(fetchFn).toHaveBeenCalledWith('/api/game/routes')
  })

  it('asks another server when one is configured', async () => {
    localStorage.setItem(SERVER_URL_KEY, 'http://localhost:8050/')
    const fetchFn = answer(200, { routes: [] })

    await fetchRoutes(fetchFn)

    expect(fetchFn).toHaveBeenCalledWith('http://localhost:8050/api/game/routes')
  })

  it('explains what is wrong when there is no list', async () => {
    await expect(fetchRoutes(vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))).rejects.toThrow('not reachable')
    // A dev server that answers every path with the client's page
    await expect(fetchRoutes(answer(200, '<html></html>', 'text/html'))).rejects.toThrow('no game server')
    await expect(fetchRoutes(answer(404, {}))).rejects.toThrow('no game server')
    await expect(fetchRoutes(answer(403, { error: 'no' }))).rejects.toThrow('localhost')
    await expect(fetchRoutes(answer(500, {}))).rejects.toThrow('500')
  })

  it('takes an answer without routes as none', async () => {
    expect(await fetchRoutes(answer(200, {}))).toEqual([])
  })

  it('groups routes by who registered them: the game, each plugin, then the engine', () => {
    const groups = groupRoutes([
      route({ path: '/api/game/health', source: 'engine' }),
      route({ path: '/chat', source: 'plugin', plugin: '@acme/chat' }),
      route({ path: '/api/scores' }),
      route({ path: '/shop', source: 'plugin', plugin: 'shop' }),
      route({ method: 'POST', path: '/chat', source: 'plugin', plugin: '@acme/chat' }),
    ])

    expect(groups.map(group => [group.from, group.routes.map(r => `${r.method} ${r.path}`)])).toEqual([
      ['Game', ['GET /api/scores']],
      ['@acme/chat', ['GET /chat', 'POST /chat']],
      ['shop', ['GET /shop']],
      ['Engine', ['GET /api/game/health']],
    ])
  })
})
