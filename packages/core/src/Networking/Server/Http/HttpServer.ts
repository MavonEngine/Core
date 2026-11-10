import type { Express, NextFunction, Request, Response } from 'express'
import type { Server as NodeServer } from 'node:http'
import type winston from 'winston'
import type { ServerPluginInfo } from '../../../Plugins/types'
import type { NetDebugSource } from '../../Debug/sync'
import type LogBuffer from '../Stats/LogBuffer'
import type RequestLog from '../Stats/RequestLog'
import type ServerMetrics from '../Stats/ServerMetrics'
import type WorldInspector from '../Stats/WorldInspector'
import type { ClientOptions } from './ClientMiddleware'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import process from 'node:process'
import express from 'express'
import { parseEntityQuery } from '../../../Dev/inspect'
import { parseNetRecordQuery } from '../../Debug/NetRecorder'
import { devEndpointsEnabled } from '../Stats/WorldInspector'
import { devClientMiddleware, staticClientMiddleware } from './ClientMiddleware'
import RouteCatalog, { describeRoute } from './RouteCatalog'

export { parseEntityQuery }

export interface MetricsEndpointOptions {
  /**
   * Expose GET /api/game/metrics, GET /api/game/logs, GET /api/game/requests, GET /api/game/routes
   * and GET /api/game/plugins.
   * Defaults to true, but in production it stays off unless a token is set.
   */
  enabled?: boolean

  /**
   * Required as `Authorization: Bearer <token>` or `?token=<token>`.
   * Without a token the endpoint only answers requests from loopback addresses.
   */
  token?: string
}

export interface HttpServerOptions {
  port?: number
  metrics?: MetricsEndpointOptions
  /** Serves recent log entries on GET /api/game/logs when given */
  logs?: LogBuffer
  /** Records the requests this server receives and serves them on GET /api/game/requests when given */
  requests?: RequestLog
  /** Serve the game client from this server, see `serveClient()` */
  client?: ClientOptions
  /**
   * Serves the scene and the world's entities on GET /api/game/dev/* when given (used by `mavonengine mcp`).
   * These routes only exist outside production (NODE_ENV !== 'production'), whatever token is set,
   * and are protected like the metrics endpoint.
   */
  inspector?: WorldInspector
  /**
   * Serves the recorded packets, network events and the state sync on GET /api/game/dev/net/* when given.
   * Same rules as `inspector`: never in production.
   */
  net?: NetDebugSource
  /** Serves the project's plugins on GET /api/game/plugins when given */
  plugins?(): ServerPluginInfo[]
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * How recently metrics must have been requested for a dashboard to count as watching.
 * Comfortably above the dashboard's default 1s poll and its 10s retry backoff.
 */
export const METRICS_CLIENT_TIMEOUT_MS = 15000

/** Shown as the `auth` of the engine's protected routes in GET /api/game/routes */
const METRICS_AUTH = 'The metrics token as `Authorization: Bearer <token>` or `?token=`. Without a configured token: requests from localhost only, and off in production'

export default class HttpServer {
  readonly app: Express

  /** Lists every route of `app`, see GET /api/game/routes */
  readonly routes: RouteCatalog

  private port: number
  private metricsOptions: MetricsEndpointOptions
  private logs?: LogBuffer
  private requests?: RequestLog
  private clientOptions?: ClientOptions
  private inspector?: WorldInspector
  private net?: NetDebugSource
  private plugins?: () => ServerPluginInfo[]
  private lastMetricsRequestAt?: number
  private listener?: NodeServer

  constructor(
    private logger: winston.Logger,
    private metrics: ServerMetrics,
    options: HttpServerOptions = {},
    app: Express = express(),
  ) {
    this.app = app
    this.port = options.port ?? 8050
    this.metricsOptions = options.metrics ?? {}
    this.logs = options.logs
    this.requests = options.requests
    this.clientOptions = options.client
    this.inspector = options.inspector
    this.net = options.net
    this.plugins = options.plugins
    this.routes = new RouteCatalog(app)

    this.routes.registerAs({ source: 'engine' }, () => {
      this.registerHealthEndpoint()
      this.registerMetricsEndpoint()
      this.registerLogsEndpoint()
      this.registerRequestsEndpoint()
      this.registerRoutesEndpoint()
      this.registerPluginsEndpoint()

      if (this.devEndpointsEnabled)
        this.registerDevEndpoints()
      if (this.net && devEndpointsEnabled())
        this.registerNetEndpoints(this.net)
    })
  }

  /**
   * Whether GET /api/game/dev/* is registered: an inspector was given and the server isn't running in production
   */
  get devEndpointsEnabled() {
    return !!this.inspector && devEndpointsEnabled()
  }

  start() {
    this.logger.info('Starting @mavon/engine - HTTP Server')
    this.listener = this.app.listen(this.port)
    this.requests?.attach(this.listener)

    this.logger.info(`Visit game server status: http://localhost:${this.port}/api/game/health`)
  }

  /**
   * The underlying Node HTTP server, once started.
   */
  get server(): NodeServer | undefined {
    return this.listener
  }

  /**
   * Mount the game client configured in `options.client`. Call it after every other route is registered,
   * because the client answers any page request that is left.
   * Returns whether a client is being served.
   */
  serveClient(): boolean {
    const client = this.clientOptions
    if (!client || !this.listener)
      return false

    if (client.dev) {
      this.app.use(devClientMiddleware(client.root, this.listener, this.logger))
      return true
    }

    const dist = client.dist ?? join(client.root, 'dist')
    const middleware = staticClientMiddleware(dist)
    if (!middleware) {
      this.logger.warn(`No built client at ${dist}, run the client build to serve it from the game server`)
      return false
    }

    this.app.use(middleware)
    this.logger.info(`Serving the built client from ${dist}: http://localhost:${this.port}/`)
    return true
  }

  get metricsEnabled() {
    const { enabled = true, token } = this.metricsOptions

    if (!enabled)
      return false

    return process.env.NODE_ENV !== 'production' || !!token
  }

  private registerHealthEndpoint() {
    this.app.get('/api/game/health', describeRoute({
      summary: 'Whether the server is up',
      response: 'Server time, uptime in seconds and how many players, entities, physics bodies and colliders there are',
      auth: 'None',
    }), (_req, res) => {
      res.json(this.metrics.health())
    })
  }

  private registerMetricsEndpoint() {
    this.app.get('/api/game/metrics', describeRoute({
      summary: 'Server statistics',
      description: 'What `mavonengine dashboard` shows: players, CPU, bandwidth, tick times and memory, each with its recent history.',
      response: 'A `ServerMetricsSnapshot`',
      auth: METRICS_AUTH,
    }), (req, res, next) => this.authorizeMetrics(req, res, next), (_req, res) => {
      this.lastMetricsRequestAt = Date.now()
      res.json(this.metrics.snapshot())
    })
  }

  /**
   * Whether something (usually `mavonengine dashboard`) has fetched metrics recently.
   */
  metricsClientActive(now = Date.now()) {
    return this.lastMetricsRequestAt !== undefined && now - this.lastMetricsRequestAt < METRICS_CLIENT_TIMEOUT_MS
  }

  /**
   * GET /api/game/logs?after=<id> returns the entries newer than `after`.
   */
  private registerLogsEndpoint() {
    this.app.get('/api/game/logs', describeRoute({
      summary: 'Recent server log entries',
      query: { after: 'Only entries with an id above this one. Default 0, which returns everything still kept' },
      response: '`{ entries, latestId }`, or 404 when the server keeps no logs',
      auth: METRICS_AUTH,
    }), (req, res, next) => this.authorizeMetrics(req, res, next), (req, res) => {
      if (!this.logs) {
        res.status(404).end()
        return
      }

      const after = Number(req.query.after ?? 0)
      res.json(this.logs.since(Number.isFinite(after) ? after : 0))
    })
  }

  /**
   * GET /api/game/requests?after=<id> returns the HTTP requests recorded after `after`.
   */
  private registerRequestsEndpoint() {
    this.app.get('/api/game/requests', describeRoute({
      summary: 'Recent HTTP requests to this server',
      query: { after: 'Only requests with an id above this one. Default 0, which returns everything still kept' },
      response: '`{ entries, latestId }`, or 404 when the server records no requests',
      auth: METRICS_AUTH,
    }), (req, res, next) => this.authorizeMetrics(req, res, next), (req, res) => {
      if (!this.requests) {
        res.status(404).end()
        return
      }

      const after = Number(req.query.after ?? 0)
      res.json(this.requests.since(Number.isFinite(after) ? after : 0))
    })
  }

  /**
   * GET /api/game/routes lists every HTTP endpoint of this server: the engine's, the game's and those of plugins.
   * Read from the app when asked, so it is always what the server answers right now.
   */
  private registerRoutesEndpoint() {
    this.app.get('/api/game/routes', describeRoute({
      summary: 'Every HTTP endpoint of this server',
      description: 'The engine\'s own endpoints, the ones the game registered and those of plugins, read from the running server. Routes say what they do with `describeRoute()`.',
      response: '`{ routes }`, each with its method, path, source and whatever it was described with',
      auth: METRICS_AUTH,
    }), (req, res, next) => this.authorizeMetrics(req, res, next), (_req, res) => {
      res.json({ routes: this.routes.list() })
    })
  }

  /**
   * GET /api/game/plugins lists the plugins of the project: the ones in mavonengine.json and the ones this server runs.
   */
  private registerPluginsEndpoint() {
    this.app.get('/api/game/plugins', describeRoute({
      summary: 'The plugins of this project',
      description: 'Every plugin in mavonengine.json with its version, target and prefabs, and whether its server entry runs in this server. See GET /api/game/routes for the endpoints a plugin registered.',
      response: '`{ plugins }`, or 404 when the server doesn\'t know its plugins',
      auth: METRICS_AUTH,
    }), (req, res, next) => this.authorizeMetrics(req, res, next), (_req, res) => {
      if (!this.plugins) {
        res.status(404).end()
        return
      }

      res.json({ plugins: this.plugins() })
    })
  }

  /**
   * GET /api/game/dev/scene                    the active scene, `{ scene: null }` without one
   * GET /api/game/dev/entities?type=&near=x,y,z&radius=&limit=&offset=
   * GET /api/game/dev/entities/:id             one entity with its serialized state, `{ entity: null }` when there is none
   *
   * Never registered in production, so there they 404 like any unknown route.
   */
  private registerDevEndpoints() {
    const inspector = this.inspector!
    const authorize = (req: Request, res: Response, next: NextFunction) => this.authorizeMetrics(req, res, next)

    const auth = `${METRICS_AUTH}. Never served in production`

    this.app.get('/api/game/dev/scene', describeRoute({
      summary: 'The active scene',
      response: '`{ scene }`, null without one',
      auth,
      devOnly: true,
    }), authorize, (_req, res) => {
      res.json({ scene: inspector.scene() })
    })

    this.app.get('/api/game/dev/entities', describeRoute({
      summary: 'The entities in the world',
      query: {
        type: 'Only entities of this type',
        near: 'Only entities around this point, as `x,y,z`',
        radius: 'How far from `near`',
        limit: 'How many to return',
        offset: 'How many to skip',
      },
      response: 'The matching entities, or 400 with `{ error }` for a query it can\'t read',
      auth,
      devOnly: true,
    }), authorize, (req, res) => {
      const query = parseEntityQuery(req.query as Record<string, unknown>)
      if (typeof query === 'string') {
        res.status(400).json({ error: query })
        return
      }

      res.json(inspector.entities(query))
    })

    this.app.get('/api/game/dev/entities/:id', describeRoute({
      summary: 'One entity with its serialized state',
      params: { id: 'Id of the entity' },
      response: '`{ entity }`, null when there is none',
      auth,
      devOnly: true,
    }), authorize, (req, res) => {
      res.json({ entity: inspector.entity(req.params.id as string) })
    })
  }

  /**
   * GET /api/game/dev/net/packets?after=&kind=&direction=&type=&peer=&limit=   recorded packets and events, oldest first
   * GET /api/game/dev/net/packets/:id                                          one record with its payload
   * GET /api/game/dev/net/sync                                                 who is sent which entities
   *
   * Never registered in production.
   */
  private registerNetEndpoints(source: NetDebugSource) {
    const authorize = (req: Request, res: Response, next: NextFunction) => this.authorizeMetrics(req, res, next)

    const auth = `${METRICS_AUTH}. Never served in production`

    this.app.get('/api/game/dev/net/packets', describeRoute({
      summary: 'Recent packets and network events of the game socket',
      query: {
        after: 'Only records with an id above this one',
        kind: '`packet` or `event`',
        direction: '`in` or `out`',
        type: 'Only these message or event names, separated by commas',
        peer: 'Only records of this client',
        limit: 'How many to return, the newest ones',
      },
      response: 'The matching records without their payloads, or 400 with `{ error }` for a query it can\'t read',
      auth,
      devOnly: true,
    }), authorize, (req, res) => {
      const query = parseNetRecordQuery(req.query as Record<string, unknown>)
      if (typeof query === 'string') {
        res.status(400).json({ error: query })
        return
      }

      res.json(source.net.list(query))
    })

    this.app.get('/api/game/dev/net/packets/:id', describeRoute({
      summary: 'One packet with its payload',
      params: { id: 'Id of the record' },
      response: '`{ record }`, null when the server no longer keeps it',
      auth,
      devOnly: true,
    }), authorize, (req, res) => {
      res.json({ record: source.net.get(Number(req.params.id)) ?? null })
    })

    this.app.get('/api/game/dev/net/sync', describeRoute({
      summary: 'Who is sent what by the state sync',
      response: 'A `SyncSnapshot`: every synced entity and each player\'s last state update',
      auth,
      devOnly: true,
    }), authorize, (_req, res) => {
      res.json(source.syncSnapshot())
    })
  }

  private authorizeMetrics(req: Request, res: Response, next: NextFunction) {
    if (!this.metricsEnabled) {
      res.status(404).end()
      return
    }

    const { token } = this.metricsOptions

    if (token) {
      const header = req.headers.authorization
      const provided = header?.startsWith('Bearer ') ? header.slice(7) : req.query.token

      if (typeof provided !== 'string' || !safeEqual(provided, token)) {
        res.status(401).json({ error: 'Invalid metrics token' })
        return
      }
    }
    else if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) {
      res.status(403).json({ error: 'Metrics are only available from localhost unless a token is configured' })
      return
    }

    next()
  }
}

function safeEqual(a: string, b: string) {
  const bufA = Buffer.from(a)
  const bufB = Buffer.from(b)

  return bufA.length === bufB.length && timingSafeEqual(bufA, bufB)
}
