import type { AdminApi, ServerPlugin, ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { Express, Request, RequestHandler, Response } from 'express'
import type { AdminToken, CredentialSource, Logger } from './auth/BasicAuth'
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
  /**
   * Serve the dashboard as a page of its own at `path`, as before the server had an admin panel. Default false: it is
   * a page of the admin panel (`/admin/monitoring/`), and `path` leads there
   */
  standalone?: boolean
}

export interface ResolvedOptions {
  path: string
  realm: string
  pollIntervalMs: number
  standalone: boolean
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
    credentials = {
      kind: 'htpasswd',
      path: isAbsolute(htpasswd)
        ? htpasswd
        : resolve(projectRoot, htpasswd),
    }
  }
  else if (env.MAVONENGINE_MONITORING_USER && env.MAVONENGINE_MONITORING_PASSWORD) {
    credentials = { kind: 'user', user: env.MAVONENGINE_MONITORING_USER, password: env.MAVONENGINE_MONITORING_PASSWORD }
  }

  return {
    path,
    realm,
    pollIntervalMs,
    standalone: options.standalone === true,
    credentials,
  }
}

function readUi(file: string): string {
  const path = resolve(UI_DIR, file)
  if (!existsSync(path))
    throw new Error(`@mavonengine/http-monitoring: ${path} is missing, the package is incomplete`)
  return readFileSync(path, 'utf8')
}

/** The dashboard's tabs, which the admin panel's sidebar links to */
const TABS = [
  { label: 'Overview', href: '#overview' },
  { label: 'Players', href: '#players' },
  { label: 'Logs', href: '#logs' },
  { label: 'HTTP', href: '#http' },
]

/** The dashboard's path under the admin panel */
const ADMIN_PAGE = 'monitoring'

const STANDALONE_TABS = `<nav class="tabs" aria-label="Dashboard tabs">
${TABS.map((tab, i) => `    <a href="${tab.href}" data-tab="${tab.href.slice(1)}"><kbd>${i + 1}</kbd> ${tab.label}</a>`).join('\n')}
  </nav>`

function afterId(req: Request): number {
  const after = Number(req.query.after ?? 0)
  return Number.isFinite(after)
    ? after
    : 0
}

type MonitoringServer = ServerPluginContext['server']

/** The page's script and stylesheet at `base` */
function serveFiles(app: Express, base: string) {
  const files = Object.fromEntries(Object.keys(UI_FILES).map(file => [
    file,
    readUi(file),
  ]))
  for (const [file, type] of Object.entries(UI_FILES))
    app.get(`${base}/${file}`, (_req: Request, res: Response) => void res.type(type).send(files[file]))
}

/** The data the page polls, at `base`/api */
function serveData(app: Express, base: string, server: MonitoringServer, guard: RequestHandler[] = []) {
  app.get(`${base}/api/metrics`, ...guard, (_req: Request, res: Response) => {
    res.json(server.metrics.snapshot())
  })

  app.get(`${base}/api/logs`, ...guard, (req: Request, res: Response) => {
    if (!server.logs) {
      res.status(404).json({ error: 'The server keeps no logs (metrics.logBufferSize is 0)' })
      return
    }
    res.json(server.logs.since(afterId(req)))
  })

  app.get(`${base}/api/requests`, ...guard, (req: Request, res: Response) => {
    if (!server.requests) {
      res.status(404).json({ error: 'The server records no requests (metrics.requestLogSize is 0)' })
      return
    }
    res.json(server.requests.since(afterId(req)))
  })
}

function panelHtml(standalone: boolean): string {
  return readUi('panel.html')
    .replace('{{BRAND}}', standalone ? '<span class="brand">MavonEngine</span>' : '')
    .replace('{{TABS}}', standalone ? STANDALONE_TABS : '')
}

/**
 * The dashboard as a page of the admin panel, behind the panel's login. The old `path` leads there, and its data
 * endpoints keep answering for tools that use them.
 */
function mountInAdmin(app: Express, admin: AdminApi, server: MonitoringServer, options: ResolvedOptions, logger: Logger | undefined) {
  const base = admin.url(ADMIN_PAGE)
  // The page polls these every second, which would bury everything else on the HTTP tab
  server.requests?.ignorePrefix?.(`${base}/api/`)
  server.requests?.ignorePrefix?.(`${options.path}/api/`)

  const html = panelHtml(false)
  admin.page({
    path: ADMIN_PAGE,
    label: 'Monitoring',
    icon: 'activity',
    order: 10,
    children: TABS,
    render: () => ({
      html,
      styles: [`${base}/style.css`],
      scripts: [`${base}/app.js`],
      data: {
        'poll-interval': String(options.pollIntervalMs),
      },
    }),
  })

  // Under the panel's path, so already behind its login
  serveFiles(app, base)
  serveData(app, base, server)

  if (options.path !== base) {
    serveData(app, options.path, server, [admin.guard])
    app.get([options.path, `${options.path}/`], (_req: Request, res: Response) => void res.redirect(302, `${base}/`))
  }

  logger?.info(`Monitoring dashboard at ${base}/ in the admin panel`)
}

/**
 * Mount the dashboard and its data endpoints on `app`: in the admin panel when the server has one, else on a page of
 * its own at `path`. Returns false when it stays off.
 */
export function mountMonitoring(app: Express, ctx: Pick<ServerPluginContext, 'server' | 'logger' | 'options' | 'projectRoot'> & { adminToken?: AdminToken, admin?: AdminApi }, env: Env = process.env): boolean {
  const logger = ctx.logger as Logger | undefined
  const options = resolveOptions(ctx.options as HttpMonitoringOptions, ctx.projectRoot ?? process.cwd(), env)
  const production = env.NODE_ENV === 'production'

  // Missing on a @mavonengine/core from before the server had an admin token
  const adminToken = ctx.adminToken?.configured ? ctx.adminToken : undefined

  if (!options.credentials && !adminToken && production) {
    logger?.warn('Monitoring is off: give the game server an admin token (MAVONENGINE_ADMIN_TOKEN, or adminToken in its options) to use it in production')
    return false
  }

  if (options.credentials?.kind === 'user')
    logger?.warn('Monitoring: MAVONENGINE_MONITORING_USER and MAVONENGINE_MONITORING_PASSWORD are deprecated. Log in with the game server\'s admin token (MAVONENGINE_ADMIN_TOKEN) as the password instead')

  const auth = new BasicAuth({
    realm: options.realm,
    credentials: options.credentials,
    adminToken,
    logger,
  })
  if (options.credentials?.kind === 'htpasswd' && auth.userCount === 0)
    logger?.warn(`Monitoring: ${options.credentials.path} has no usable users, nobody can log in`)

  const { server } = ctx

  // Missing on a @mavonengine/core from before the admin panel
  const admin = ctx.admin
  if (admin && !options.standalone) {
    // The htpasswd users log in to the whole panel, like the admin token does
    if (options.credentials)
      admin.addLogin((user, password) => auth.verify(user, password))

    if (admin.enabled) {
      mountInAdmin(app, admin, server, options, logger)
      return true
    }
  }

  const base = options.path
  server.requests?.ignorePrefix?.(`${base}/api/`)

  const page = readUi('index.html')
    .replace('{{PANEL}}', panelHtml(true))
    .replace('{{POLL_INTERVAL_MS}}', String(options.pollIntervalMs))

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

  serveFiles(app, base)
  serveData(app, base, server)

  const logins = [
    ...(adminToken
      ? ['the game server\'s admin token as the password']
      : []),
    ...(options.credentials
      ? [
          options.credentials.kind === 'htpasswd'
            ? `a user from ${options.credentials.path}`
            : `user "${options.credentials.user}"`,
        ]
      : []),
  ]
  if (logins.length)
    logger?.info(`Monitoring dashboard at ${base}/, login with ${logins.join(' or ')}`)
  else
    logger?.warn(`Monitoring dashboard at ${base}/, only from this machine: the game server has no admin token`)

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
      mountMonitoring(app, {
        ...ctx,
        options: {
          ...defaults,
          ...ctx.options,
        },
      })
    },
  }
}

export default createHttpMonitoring()
