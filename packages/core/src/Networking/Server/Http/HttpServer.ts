import type { Express, NextFunction, Request, Response } from 'express'
import type { Server as NodeServer } from 'node:http'
import type winston from 'winston'
import type LogBuffer from '../Stats/LogBuffer'
import type ServerMetrics from '../Stats/ServerMetrics'
import type { ClientOptions } from './ClientMiddleware'
import { Buffer } from 'node:buffer'
import { timingSafeEqual } from 'node:crypto'
import { join } from 'node:path'
import process from 'node:process'
import express from 'express'
import { devClientMiddleware, staticClientMiddleware } from './ClientMiddleware'

export interface MetricsEndpointOptions {
  /**
   * Expose GET /api/game/metrics and GET /api/game/logs.
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
  /** Serve the game client from this server, see `serveClient()` */
  client?: ClientOptions
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * How recently metrics must have been requested for a dashboard to count as watching.
 * Comfortably above the dashboard's default 1s poll and its 10s retry backoff.
 */
export const METRICS_CLIENT_TIMEOUT_MS = 15000

export default class HttpServer {
  readonly app: Express

  private port: number
  private metricsOptions: MetricsEndpointOptions
  private logs?: LogBuffer
  private clientOptions?: ClientOptions
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
    this.clientOptions = options.client

    this.registerHealthEndpoint()
    this.registerMetricsEndpoint()
    this.registerLogsEndpoint()
  }

  start() {
    this.logger.info('Starting @mavon/engine - HTTP Server')
    this.listener = this.app.listen(this.port)

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
    this.app.get('/api/game/health', (_req, res) => {
      res.json(this.metrics.health())
    })
  }

  private registerMetricsEndpoint() {
    this.app.get('/api/game/metrics', (req, res, next) => this.authorizeMetrics(req, res, next), (_req, res) => {
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
    this.app.get('/api/game/logs', (req, res, next) => this.authorizeMetrics(req, res, next), (req, res) => {
      if (!this.logs) {
        res.status(404).end()
        return
      }

      const after = Number(req.query.after ?? 0)
      res.json(this.logs.since(Number.isFinite(after) ? after : 0))
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
