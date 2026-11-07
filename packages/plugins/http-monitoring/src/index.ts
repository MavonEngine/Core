import type { ServerPlugin, ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { Express, Request, Response } from 'express'
import type { CredentialSource, Logger } from './auth/BasicAuth'
import { existsSync, readFileSync } from 'node:fs'
import { isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import BasicAuth from './auth/BasicAuth'

export { apr1 } from './auth/apr1'
export { default as BasicAuth, parseBasicAuth } from './auth/BasicAuth'
export { parseHtpasswd, verifierFor } from './auth/htpasswd'

export interface HttpMonitoringOptions {
  /** URL path the dashboard is served under. Default `/monitoring` */
  path?: string
  /**
   * htpasswd file with the users that may log in, relative to the project root.
   * Also `MAVONENGINE_MONITORING_HTPASSWD`. bcrypt (`htpasswd -B`), MD5 (`$apr1$`) and `{SHA}` hashes are supported.
   */
  htpasswd?: string
  /** Shown in the browser's login prompt. Default `MavonEngine monitoring` */
  realm?: string
  /** How often the page fetches new data, in ms. Default 1000 */
  pollIntervalMs?: number
}

export interface ResolvedOptions {
  path: string
  realm: string
  pollIntervalMs: number
  credentials?: CredentialSource
}

type Env = Record<string, string | undefined>

const TRAILING_SLASHES_RE = /\/+$/
const LEADING_SLASHES_RE = /^\/+/
const UI_FILES = {
  'app.js': 'text/javascript',
  'format.js': 'text/javascript',
  'style.css': 'text/css',
} as const

/** The browser page, next to dist/ (and src/ in development) */
const UI_DIR = fileURLToPath(new URL('../ui/', import.meta.url))

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': 'default-src \'self\'; img-src \'self\' data:; frame-ancestors \'none\'; base-uri \'none\'; form-action \'none\'',
}

/**
 * Options from mavonengine.json, the environment and defaults.
 * `htpasswd` wins over `MAVONENGINE_MONITORING_USER` / `MAVONENGINE_MONITORING_PASSWORD`.
 */
export function resolveOptions(options: HttpMonitoringOptions, projectRoot: string, env: Env = process.env): ResolvedOptions {
  const path = `/${(options.path ?? '/monitoring').replace(LEADING_SLASHES_RE, '').replace(TRAILING_SLASHES_RE, '')}`
  if (path === '/')
    throw new Error('@mavonengine/http-monitoring: "path" can\'t be the site root, it would hide the game')

  const pollIntervalMs = Math.max(250, Number(options.pollIntervalMs ?? 1000) || 1000)
  const realm = options.realm ?? 'MavonEngine monitoring'

  let credentials: CredentialSource | undefined
  const htpasswd = options.htpasswd ?? env.MAVONENGINE_MONITORING_HTPASSWD
  if (htpasswd) {
    credentials = { kind: 'htpasswd', path: isAbsolute(htpasswd) ? htpasswd : resolve(projectRoot, htpasswd) }
  }
  else if (env.MAVONENGINE_MONITORING_USER && env.MAVONENGINE_MONITORING_PASSWORD) {
    credentials = { kind: 'user', user: env.MAVONENGINE_MONITORING_USER, password: env.MAVONENGINE_MONITORING_PASSWORD }
  }

  return { path, realm, pollIntervalMs, credentials }
}

function readUi(file: string): string {
  const path = resolve(UI_DIR, file)
  if (!existsSync(path))
    throw new Error(`@mavonengine/http-monitoring: ${path} is missing, the package is incomplete`)
  return readFileSync(path, 'utf8')
}

function afterId(req: Request): number {
  const after = Number(req.query.after ?? 0)
  return Number.isFinite(after) ? after : 0
}

/**
 * Mount the dashboard and its data endpoints on `app`. Returns false when it stays off.
 */
export function mountMonitoring(app: Express, ctx: Pick<ServerPluginContext, 'server' | 'logger' | 'options' | 'projectRoot'>, env: Env = process.env): boolean {
  const logger = ctx.logger as Logger | undefined
  const options = resolveOptions(ctx.options as HttpMonitoringOptions, ctx.projectRoot ?? process.cwd(), env)
  const production = env.NODE_ENV === 'production'

  if (!options.credentials && production) {
    logger?.warn('Monitoring is off: set "htpasswd" in its mavonengine.json options, or MAVONENGINE_MONITORING_USER and MAVONENGINE_MONITORING_PASSWORD, to use it in production')
    return false
  }

  const auth = new BasicAuth({ realm: options.realm, credentials: options.credentials, logger })
  if (options.credentials?.kind === 'htpasswd' && auth.userCount === 0)
    logger?.warn(`Monitoring: ${options.credentials.path} has no usable users, nobody can log in`)

  const { server } = ctx
  const base = options.path
  // The page polls these every second, which would bury everything else on the HTTP tab
  server.requests?.ignorePrefix?.(`${base}/api/`)

  const page = readUi('index.html').replace('{{POLL_INTERVAL_MS}}', String(options.pollIntervalMs))
  const files = Object.fromEntries(Object.keys(UI_FILES).map(file => [file, readUi(file)]))

  app.use(base, (_req: Request, res: Response, next) => {
    res.set(SECURITY_HEADERS)
    next()
  }, auth.middleware)

  app.get(base, (req: Request, res: Response) => {
    // Relative URLs on the page need the trailing slash
    if (!req.originalUrl.split('?')[0].endsWith('/')) {
      res.redirect(301, `${base}/`)
      return
    }
    res.type('html').send(page)
  })

  for (const [file, type] of Object.entries(UI_FILES))
    app.get(`${base}/${file}`, (_req: Request, res: Response) => void res.type(type).send(files[file]))

  app.get(`${base}/api/metrics`, (_req: Request, res: Response) => {
    res.json(server.metrics.snapshot())
  })

  app.get(`${base}/api/logs`, (req: Request, res: Response) => {
    if (!server.logs) {
      res.status(404).json({ error: 'The server keeps no logs (metrics.logBufferSize is 0)' })
      return
    }
    res.json(server.logs.since(afterId(req)))
  })

  app.get(`${base}/api/requests`, (req: Request, res: Response) => {
    if (!server.requests) {
      res.status(404).json({ error: 'The server records no requests (metrics.requestLogSize is 0)' })
      return
    }
    res.json(server.requests.since(afterId(req)))
  })

  if (options.credentials)
    logger?.info(`Monitoring dashboard at ${base}/, login with ${options.credentials.kind === 'htpasswd' ? `a user from ${options.credentials.path}` : `user "${options.credentials.user}"`}`)
  else
    logger?.warn(`Monitoring dashboard at ${base}/, only from this machine: no login is configured`)

  return true
}

/**
 * The plugin. Registered through mavonengine.json it reads its options from there;
 * `createHttpMonitoring(options)` is for passing it to `ServerOptions.plugins` directly.
 */
export function createHttpMonitoring(defaults: HttpMonitoringOptions = {}): ServerPlugin {
  return {
    name: 'HTTP monitoring',
    http(app, ctx) {
      mountMonitoring(app, { ...ctx, options: { ...defaults, ...ctx.options } })
    },
  }
}

export default createHttpMonitoring()
