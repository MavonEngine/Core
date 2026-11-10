import express from 'express'
import { describe, expect, it } from 'vitest'
import RouteCatalog, { describeRoute } from '../../../../src/Networking/Server/Http/RouteCatalog'

const handler = (_req: unknown, res: { end(): void }) => res.end()

describe('routeCatalog', () => {
  it('lists the routes of the app in the order they were registered', () => {
    const app = express()
    const catalog = new RouteCatalog(app)

    app.get('/api/scores', handler)
    app.post('/api/scores', handler)
    app.all('/api/anything', handler)

    expect(catalog.list()).toEqual([
      { method: 'GET', path: '/api/scores', source: 'game', params: {}, devOnly: false },
      { method: 'POST', path: '/api/scores', source: 'game', params: {}, devOnly: false },
      { method: 'ALL', path: '/api/anything', source: 'game', params: {}, devOnly: false },
    ])
  })

  it('sees routes that are added after it was last asked', () => {
    const app = express()
    const catalog = new RouteCatalog(app)
    expect(catalog.list()).toEqual([])

    app.get('/late', handler)

    expect(catalog.list().map(route => route.path)).toEqual(['/late'])
  })

  it('lists every method and path of a route', () => {
    const app = express()
    const catalog = new RouteCatalog(app)

    app.route('/api/item').get(handler).delete(handler)
    app.get(['/a', '/b'], handler)

    expect(catalog.list().map(route => `${route.method} ${route.path}`)).toEqual(['GET /api/item', 'DELETE /api/item', 'GET /a', 'GET /b'])
  })

  it('says where routes come from', () => {
    const app = express()
    const catalog = new RouteCatalog(app)

    catalog.registerAs({ source: 'engine' }, () => app.get('/api/game/health', handler))
    app.get('/api/scores', handler)
    catalog.registerAs({ source: 'plugin', plugin: '@acme/chat' }, () => {
      app.get('/chat', handler)
      app.post('/chat', handler)
    })

    expect(catalog.list().map(({ path, method, source, plugin }) => ({ method, path, source, plugin }))).toEqual([
      { method: 'GET', path: '/api/game/health', source: 'engine', plugin: undefined },
      { method: 'GET', path: '/api/scores', source: 'game', plugin: undefined },
      { method: 'GET', path: '/chat', source: 'plugin', plugin: '@acme/chat' },
      { method: 'POST', path: '/chat', source: 'plugin', plugin: '@acme/chat' },
    ])
  })

  it('keeps the origin of what was registered when registering throws', () => {
    const app = express()
    const catalog = new RouteCatalog(app)

    expect(() => catalog.registerAs({ source: 'plugin', plugin: 'broken' }, () => {
      app.get('/before-it-broke', handler)
      throw new Error('boom')
    })).toThrow('boom')

    expect(catalog.list()).toMatchObject([{ path: '/before-it-broke', plugin: 'broken' }])
  })

  it('adds what a route was described with, and finds the parameters in its path', () => {
    const app = express()
    const catalog = new RouteCatalog(app)

    app.get('/api/teams/:team/players/:id', describeRoute({
      summary: 'One player',
      params: { id: 'Id of the player' },
      query: { full: 'Include the inventory' },
      response: 'The player',
      auth: 'None',
    }), handler)

    expect(catalog.list()).toEqual([{
      method: 'GET',
      path: '/api/teams/:team/players/:id',
      source: 'game',
      summary: 'One player',
      params: { team: '', id: 'Id of the player' },
      query: { full: 'Include the inventory' },
      response: 'The player',
      auth: 'None',
      devOnly: false,
    }])
  })

  it('tells routes that only exist in development from those served in production too', () => {
    const app = express()
    const catalog = new RouteCatalog(app)

    app.get('/api/debug/state', describeRoute({ devOnly: true }), handler)
    app.get('/api/scores', describeRoute({ summary: 'The high scores' }), handler)
    app.get('/api/undescribed', handler)

    expect(catalog.list().map(route => [route.path, route.devOnly])).toEqual([
      ['/api/debug/state', true],
      ['/api/scores', false],
      ['/api/undescribed', false],
    ])
  })

  it('lists the routes of a router under the path it was mounted on', () => {
    const app = express()
    const catalog = new RouteCatalog(app)
    const router = express.Router()
    router.get('/', handler)
    router.get('/:id', handler)

    catalog.registerAs({ source: 'plugin', plugin: 'shop' }, () => app.use('/shop/', router))
    app.use(router)

    expect(catalog.list().map(({ path, source }) => `${source} ${path}`)).toEqual(['plugin /shop', 'plugin /shop/:id', 'game /', 'game /:id'])
  })

  it('leaves out middleware and routers it has no path for', () => {
    const app = express()
    const catalog = new RouteCatalog(app)
    const outer = express.Router()
    const inner = express.Router()
    inner.get('/hidden', handler)
    outer.use('/inner', inner)
    outer.get('/shown', handler)

    app.use((_req, _res, next) => next())
    app.use('/outer', outer)

    expect(catalog.list().map(route => route.path)).toEqual(['/outer/shown'])
  })

  it('still routes requests through a described route and app.use()', async () => {
    const app = express()
    const catalog = new RouteCatalog(app)
    const router = express.Router()
    router.get('/ping', (_req, res) => void res.json({ pong: true }))
    app.use('/api', router)
    app.get('/described', describeRoute({ summary: 'x' }), (_req, res) => void res.json({ ok: true }))

    const server = await new Promise<import('node:http').Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening))
    })
    const { port } = server.address() as import('node:net').AddressInfo

    try {
      expect(await (await fetch(`http://127.0.0.1:${port}/api/ping`)).json()).toEqual({ pong: true })
      expect(await (await fetch(`http://127.0.0.1:${port}/described`)).json()).toEqual({ ok: true })
      expect(catalog.list()).toHaveLength(2)
    }
    finally {
      server.close()
    }
  })

  it('lists nothing for something that is no Express app', () => {
    expect(new RouteCatalog({} as any).list()).toEqual([])
  })
})
