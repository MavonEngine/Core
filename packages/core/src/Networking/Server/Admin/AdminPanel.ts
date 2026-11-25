import type { Express, NextFunction, Request, RequestHandler, Response } from 'express'
import type winston from 'winston'
import type { AdminToken } from '../../../Plugins/types'
import type Logger from '../../../Utils/Logger'
import type { LayoutNavGroup, LayoutNavItem } from './layout'
import type { AdminApi, AdminLogin, AdminNavLink, AdminPage, AdminPageContent } from './types'
import { Buffer } from 'node:buffer'
import process from 'node:process'
import express from 'express'
import { describeAuth, describeRoute } from '../Http/RouteCatalog'
import { ADMIN_SCRIPT, escapeHtml, renderLayout } from './layout'
import { ADMIN_CSS } from './styles'

export type { AdminApi, AdminIcon, AdminLogin, AdminNavLink, AdminPage, AdminPageContent, AdminRender } from './types'
export { escapeHtml }

export interface AdminPanelOptions {
  /** Serve the admin panel. Default true; in production it stays off until the server has an admin token or a login */
  enabled?: boolean
  /** Where it is served. Default `/admin`. Can't be `/` */
  path?: string
}

export interface AdminPanelDeps {
  adminToken: AdminToken
  logger?: winston.Logger | Logger | null
  /** The game's name, shown in the sidebar */
  appName?(): string | undefined
  /** Whether the server runs in production. Default: NODE_ENV is `production` */
  production?(): boolean
  now?(): number
}

interface RegisteredPage {
  page: AdminPage
  /** npm package of the plugin that registered it, undefined for the engine and the game */
  plugin?: string
  /** In the order pages were registered, so pages of the same order keep it */
  index: number
}

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])
const BASIC_RE = /^Basic ([A-Z0-9+/=]+)$/i
const BEARER_RE = /^Bearer (\S+)$/i
const EDGE_SLASHES_RE = /^\/+|\/+$/g
const ABSOLUTE_HREF_RE = /^(?:[a-z][a-z0-9+.-]*:|\/)/i
const REALM = 'MavonEngine admin'
const MAX_FAILURES = 10
const LOCKOUT_MS = 5 * 60 * 1000
const AUTHORIZED = Symbol('mavonengine.adminAuthorized')
const ADMIN_AUTH = 'The admin login: the server\'s admin token as the password (any user name) or as `Authorization: Bearer <token>`, or a login a plugin added. Without either: localhost only, and off in production'

const SECURITY_HEADERS = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy': 'default-src \'self\'; img-src \'self\' data:; frame-ancestors \'none\'; base-uri \'none\'; form-action \'self\'',
}

const trimSlashes = (path: string) => path.replace(EDGE_SLASHES_RE, '')

function parseBasic(header: string | undefined): { user: string, password: string } | undefined {
  const encoded = header
    ? BASIC_RE.exec(header.trim())?.[1]
    : undefined
  if (!encoded)
    return undefined
  const decoded = Buffer.from(encoded, 'base64').toString('utf8')
  const colon = decoded.indexOf(':')
  return colon < 0
    ? undefined
    : {
        user: decoded.slice(0, colon),
        password: decoded.slice(colon + 1),
      }
}

/**
 * The server's admin panel: one layout with a sidebar, served under `/admin`, that the engine and plugins add pages
 * to with `page()`. Everything under its path is behind the admin login: the server's admin token as the password of
 * the browser's prompt (any user name) or as `Authorization: Bearer <token>`, plus the logins plugins add.
 * Without a token or a login it only answers localhost, and in production it stays off.
 */
export default class AdminPanel implements AdminApi {
  readonly path: string
  readonly guard: RequestHandler

  private pages = new Map<string, RegisteredPage>()
  private logins: AdminLogin[] = []
  private failures = new Map<string, { count: number, since: number }>()
  private registered = 0
  private readonly turnedOn: boolean
  private readonly production: () => boolean
  private readonly now: () => number

  constructor(private deps: AdminPanelDeps, options: AdminPanelOptions = {}) {
    const path = trimSlashes(options.path ?? '/admin')
    if (!path)
      throw new Error('The admin panel can\'t be served at the site root, it would hide the game')

    this.path = `/${path}`
    this.turnedOn = options.enabled !== false
    this.production = deps.production ?? (() => process.env.NODE_ENV === 'production')
    this.now = deps.now ?? Date.now
    this.guard = describeAuth(
      (req, res, next) => void this.authorize(req, res).then(ok => ok && next(), next),
      ADMIN_AUTH,
    )
  }

  get enabled(): boolean {
    return this.turnedOn && (!this.production() || this.deps.adminToken.configured || this.logins.length > 0)
  }

  url(path = ''): string {
    const rest = trimSlashes(path)
    return rest
      ? `${this.path}/${rest}`
      : this.path
  }

  page(page: AdminPage, plugin?: string): void {
    const path = trimSlashes(page.path)
    const previous = this.pages.get(path)
    this.pages.set(path, {
      page: { ...page, path },
      plugin,
      index: previous?.index ?? this.registered++,
    })
  }

  addLogin(login: AdminLogin): void {
    this.logins.push(login)
  }

  /** The registered pages, in sidebar order */
  list(): (AdminPage & { plugin?: string })[] {
    return this.sorted().map(({ page, plugin }) => ({ ...page, plugin }))
  }

  /** `ctx.admin` of a plugin: its pages are listed under Plugins unless they say otherwise */
  forPlugin(pkg: string): AdminApi {
    // eslint-disable-next-line ts/no-this-alias
    const panel = this
    return {
      path: this.path,
      get enabled() {
        return panel.enabled
      },
      guard: this.guard,
      url: path => this.url(path),
      page: page => this.page({ group: 'Plugins', ...page }, pkg),
      addLogin: login => this.addLogin(login),
    }
  }

  /** Serve the panel on `app`. Call it before other routes under its path, which then sit behind its login */
  mount(app: Express): void {
    const router = express.Router()

    router.use((req, res, next) => {
      if (!this.enabled) {
        next('router')
        return
      }
      res.set(SECURITY_HEADERS)
      next()
    }, this.guard)

    // Middleware rather than routes, so GET /api/game/routes doesn't list the layout's files
    const files: Record<string, [type: string, body: string]> = {
      '/_admin/admin.css': ['text/css', ADMIN_CSS],
      '/_admin/admin.js': ['text/javascript', ADMIN_SCRIPT],
    }
    router.use((req, res, next) => {
      const file = req.method === 'GET' || req.method === 'HEAD'
        ? files[req.path]
        : undefined
      if (!file) {
        next()
        return
      }
      res.type(file[0]).send(file[1])
    })

    router.get('/{*page}', describeRoute({
      summary: 'A page of the admin panel',
      description: 'The panel\'s layout with the page the engine or a plugin registered at this path. Paths no page has fall through to the routes registered after it.',
      response: 'HTML',
      auth: ADMIN_AUTH,
    }), (req, res, next) => void this.serve(req, res, next))

    app.use(this.path, router)
  }

  private sorted(): RegisteredPage[] {
    return [
      ...this.pages.values(),
    ].sort((a, b) => (a.page.order ?? 100) - (b.page.order ?? 100) || a.index - b.index)
  }

  private pageUrl(path: string): string {
    return `${this.url(path)}/`
  }

  /** Where a sidebar link under `page` goes, and the sub page path it stands for when it is one */
  private childTarget(page: AdminPage, child: AdminNavLink): { href: string, hash?: string, path?: string } {
    if (child.href.startsWith('#')) {
      return {
        href: `${this.pageUrl(page.path)}${child.href}`,
        hash: child.href.slice(1),
      }
    }
    if (ABSOLUTE_HREF_RE.test(child.href))
      return { href: child.href }
    const path = [
      page.path,
      trimSlashes(child.href),
    ].filter(Boolean).join('/')
    return {
      href: this.pageUrl(path),
      path,
    }
  }

  /** The page and, for a sub page, the link that serves `path` */
  private resolve(path: string): { page: AdminPage, child?: AdminNavLink } | undefined {
    const exact = this.pages.get(path)
    if (exact)
      return { page: exact.page }

    for (const { page } of this.pages.values()) {
      const child = page.children?.find(c => c.render && this.childTarget(page, c).path === path)
      if (child)
        return { page, child }
    }
    return undefined
  }

  private nav(current: AdminPage, path: string): LayoutNavGroup[] {
    const groups = new Map<string, LayoutNavItem[]>()
    for (const { page, plugin } of this.sorted()) {
      const group = page.group ?? (plugin ? 'Plugins' : 'Server')
      const items = groups.get(group) ?? []
      groups.set(group, items)
      items.push({
        label: page.label,
        href: this.pageUrl(page.path),
        icon: page.icon,
        current: page === current,
        children: (page.children ?? []).map((child) => {
          const target = this.childTarget(page, child)
          return {
            label: child.label,
            href: target.href,
            hash: target.hash,
            current: target.path === path,
          }
        }),
      })
    }

    // The engine's own pages first, then the rest in the order their first page sorts
    const server = groups.get('Server')
    const entries = [
      ...groups.entries(),
    ].filter(([label]) => label !== 'Server')
    return [
      ...(server
        ? [
            { label: 'Server', items: server },
          ]
        : []),
      ...entries.map(([label, items]) => ({ label, items })),
    ]
  }

  private async serve(req: Request, res: Response, next: NextFunction) {
    const path = trimSlashes(req.path)
    const match = this.resolve(path)
    if (!match) {
      next()
      return
    }

    // Relative URLs on a page need its trailing slash
    const [pathname, query] = req.originalUrl.split('?')
    if (!pathname.endsWith('/')) {
      res.redirect(301, `${pathname}/${query === undefined
        ? ''
        : `?${query}`}`)
      return
    }

    const { page, child } = match
    let content: AdminPageContent
    let status = 200
    try {
      const rendered = await (child?.render ?? page.render)(req)
      content = typeof rendered === 'string'
        ? { html: rendered }
        : rendered
    }
    catch (err) {
      const message = (err as Error)?.message ?? String(err)
      this.deps.logger?.error(`Admin page ${this.pageUrl(path)} failed: ${(err as Error)?.stack ?? message}`)
      status = 500
      content = { html: `<div class="adm-page"><p class="adm-danger">This page failed: ${escapeHtml(message)}</p></div>` }
    }

    if (res.headersSent)
      return

    const title = content.title ?? (child
      ? `${page.label} · ${child.label}`
      : page.label)
    res.status(status).type('html').send(renderLayout({
      base: this.path,
      appName: this.deps.appName?.(),
      nav: this.nav(page, path),
      content,
      title,
    }))
  }

  private async authorize(req: Request, res: Response): Promise<boolean> {
    const marked = req as unknown as Record<symbol, boolean>
    if (marked[AUTHORIZED])
      return true

    const address = req.socket.remoteAddress ?? 'unknown'
    const token = this.deps.adminToken

    if (!token.configured && this.logins.length === 0) {
      if (LOOPBACK_ADDRESSES.has(address))
        return (marked[AUTHORIZED] = true)
      res.status(403).type('text/plain').send('The admin panel only answers this machine until the server has an admin token (MAVONENGINE_ADMIN_TOKEN)\n')
      return false
    }

    const lockedFor = this.lockedOutFor(address)
    if (lockedFor > 0) {
      res.setHeader('Retry-After', String(Math.ceil(lockedFor / 1000)))
      res.status(429).type('text/plain').send('Too many failed logins, try again later\n')
      return false
    }

    const bearer = BEARER_RE.exec(req.headers.authorization?.trim() ?? '')?.[1]
    const basic = parseBasic(req.headers.authorization)
    const allowed = (bearer !== undefined && token.matches(bearer))
      || (!!basic && (token.matches(basic.password) || await this.checkLogins(basic.user, basic.password)))

    if (allowed) {
      this.failures.delete(address)
      return (marked[AUTHORIZED] = true)
    }

    if (basic || bearer !== undefined) {
      this.recordFailure(address)
      this.deps.logger?.warn(`Admin: failed login ${basic
        ? `for "${basic.user}"`
        : 'with a token'} from ${address}`)
    }

    res.setHeader('WWW-Authenticate', `Basic realm="${REALM}", charset="UTF-8"`)
    res.status(401).type('text/plain').send('Login required\n')
    return false
  }

  private async checkLogins(user: string, password: string): Promise<boolean> {
    for (const login of this.logins) {
      try {
        if (await login(user, password))
          return true
      }
      catch (err) {
        this.deps.logger?.error(`Admin: a login check failed: ${(err as Error)?.message ?? err}`)
      }
    }
    return false
  }

  private lockedOutFor(address: string): number {
    const entry = this.failures.get(address)
    if (!entry)
      return 0
    const elapsed = this.now() - entry.since
    if (elapsed >= LOCKOUT_MS) {
      this.failures.delete(address)
      return 0
    }
    return entry.count >= MAX_FAILURES
      ? LOCKOUT_MS - elapsed
      : 0
  }

  private recordFailure(address: string) {
    const entry = this.failures.get(address)
    if (entry) {
      entry.count++
    }
    else {
      this.failures.set(address, {
        count: 1,
        since: this.now(),
      })
    }

    // Don't let an address scan grow this forever
    if (this.failures.size > 10000)
      this.failures.delete(this.failures.keys().next().value!)
  }
}
