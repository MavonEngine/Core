import type { Express, RequestHandler } from 'express'
import type { HttpRouteDoc, HttpRouteInfo, HttpRouteSource } from './RouteInfo'
import { METHODS } from 'node:http'

export type { HttpRouteDoc, HttpRouteInfo, HttpRouteSource }

/** Registered symbol, so a plugin that bundles its own copy of this file still describes its routes */
const ROUTE_DOC = Symbol.for('mavonengine.routeDoc')

/** Registered symbol a guard says who it lets through with, for routes that don't say themselves */
const ROUTE_AUTH = Symbol.for('mavonengine.routeAuth')

const PATH_PARAM_RE = /:(\w+)/g
const DUPLICATE_SLASHES_RE = /\/{2,}/g
const TRAILING_SLASH_RE = /(?<=.)\/$/

/**
 * Say what a route does, for the endpoint list of the dashboard and the editor. Put it in front of the handler:
 *
 *   app.get('/api/scores/:id', describeRoute({ summary: 'One score', params: { id: 'Id of the player' } }), handler)
 *
 * Mark a route you only register in development with `devOnly: true`, else it is listed as served in production too.
 * It does nothing to the request.
 */
export function describeRoute(doc: HttpRouteDoc): RequestHandler {
  const handler: RequestHandler = (_req, _res, next) => next()
  ;(handler as unknown as Record<symbol, HttpRouteDoc>)[ROUTE_DOC] = doc
  return handler
}

/**
 * Say who a guard lets through, e.g. "The admin token". Every route the guard is put in front of then lists
 * that as its `auth`, unless the route describes its own. Returns the guard.
 */
export function describeAuth<T extends RequestHandler>(guard: T, auth: string): T {
  ;(guard as unknown as Record<symbol, string>)[ROUTE_AUTH] = auth
  return guard
}

export interface RouteOrigin {
  source: HttpRouteSource
  /** npm package of the plugin, when `source` is `plugin` */
  plugin?: string
}

/** The parts of Express' router this file reads. Express has no public way to list routes */
interface Layer {
  handle?: { stack?: Layer[] } & Record<symbol, unknown>
  route?: {
    path: unknown
    methods: Record<string, boolean>
    stack: Layer[]
  }
}

function joinPaths(prefix: string, path: string): string {
  return `${prefix}/${path}`.replace(DUPLICATE_SLASHES_RE, '/').replace(TRAILING_SLASH_RE, '')
}

/**
 * Lists the routes of an Express app by reading them from its router whenever it is asked, so routes need no
 * registration of their own to show up: whatever `app.get()`, `app.post()`, … or a router mounted with
 * `app.use()` added is listed, whoever added it.
 *
 * Not listed: middleware without a route (like the game client), and routers mounted inside another router,
 * because Express doesn't keep the path they were mounted on.
 */
export default class RouteCatalog {
  private origins = new WeakMap<Layer, RouteOrigin>()
  /** Paths a layer was mounted on with `app.use()`: Express doesn't keep them */
  private mounts = new WeakMap<Layer, string[]>()

  constructor(private app: Express) {
    const use = app.use

    if (typeof use !== 'function')
      return

    app.use = ((...args: unknown[]) => {
      const before = this.stack.length
      const result = (use as (...args: unknown[]) => unknown).apply(app, args)
      const [first] = args
      const paths = typeof first === 'string'
        ? [first]
        : Array.isArray(first) && first.every(path => typeof path === 'string') ? first as string[] : ['/']

      for (const layer of this.stack.slice(before))
        this.mounts.set(layer, paths)

      return result
    }) as Express['use']
  }

  private get stack(): Layer[] {
    const stack = (this.app as unknown as { router?: { stack?: Layer[] } }).router?.stack
    return Array.isArray(stack) ? stack : []
  }

  /**
   * Run `register` and remember that the routes it adds come from `origin`.
   * Routes added outside of it count as the game's own.
   */
  registerAs<T>(origin: RouteOrigin, register: () => T): T {
    const before = this.stack.length
    try {
      return register()
    }
    finally {
      for (const layer of this.stack.slice(before))
        this.origins.set(layer, origin)
    }
  }

  /**
   * Every route the app has right now, in the order they were registered
   */
  list(): HttpRouteInfo[] {
    const routes: HttpRouteInfo[] = []
    this.collect(this.stack, '', undefined, routes)
    return routes
  }

  private collect(stack: Layer[], prefix: string, inherited: RouteOrigin | undefined, routes: HttpRouteInfo[]) {
    for (const layer of stack) {
      const origin = this.origins.get(layer) ?? inherited ?? { source: 'game' }

      if (layer.route) {
        this.addRoute(layer.route, prefix, origin, routes)
      }
      else if (Array.isArray(layer.handle?.stack)) {
        // A router. Without a known mount path its routes can't be given their real path
        for (const mount of this.mounts.get(layer) ?? [])
          this.collect(layer.handle.stack, joinPaths(prefix, mount), origin, routes)
      }
    }
  }

  private addRoute(route: NonNullable<Layer['route']>, prefix: string, origin: RouteOrigin, routes: HttpRouteInfo[]) {
    const doc = route.stack.map(layer => layer.handle?.[ROUTE_DOC]).find(Boolean) as HttpRouteDoc | undefined
    // What its guard says, when the route doesn't say who may call it
    const auth = doc?.auth ?? route.stack.map(layer => layer.handle?.[ROUTE_AUTH]).find(Boolean) as string | undefined
    const registered = Object.keys(route.methods).filter(method => route.methods[method])
    // app.all() registers the route once per HTTP method
    const all = registered.includes('_all') || METHODS.every(method => route.methods[method.toLowerCase()])
    const methods = all ? ['ALL'] : registered.map(method => method.toUpperCase())
    const paths = (Array.isArray(route.path) ? route.path : [route.path]).map(path => joinPaths(prefix, String(path)))

    for (const path of paths) {
      const params: Record<string, string> = {}
      for (const [, name] of path.matchAll(PATH_PARAM_RE))
        params[name] = doc?.params?.[name] ?? ''

      for (const method of methods) {
        routes.push({
          ...doc,
          ...(auth ? { auth } : {}),
          method,
          path,
          source: origin.source,
          ...(origin.plugin ? { plugin: origin.plugin } : {}),
          params,
          devOnly: doc?.devOnly === true,
        })
      }
    }
  }
}
