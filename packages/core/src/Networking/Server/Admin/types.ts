import type { Request, RequestHandler } from 'express'

/** Icons the sidebar has built in. Anything else shows the label's first letter */
export type AdminIcon = 'dashboard' | 'activity' | 'routes' | 'plugin' | 'database' | 'users' | 'logs' | 'settings' | 'chart' | 'mail' | 'chat' | 'bell' | 'lock'

/**
 * What an admin page shows in the layout's content area.
 */
export interface AdminPageContent {
  /**
   * The page's HTML, put into the layout as is: escape whatever came from players or requests with `escapeHtml()`.
   * Inline `<script>` and `style` attributes are blocked by the Content-Security-Policy: ship script and style files.
   */
  html: string
  /** Shown in the top bar and the browser tab. Defaults to the page's label */
  title?: string
  /** Stylesheet URLs to load after the layout's own, e.g. `ctx.admin.url('monitoring/style.css')` */
  styles?: string[]
  /** Module script URLs to load at the end of the page */
  scripts?: string[]
  /** `data-*` attributes for `<body>`, without the `data-` prefix, e.g. `{ 'poll-interval': '1000' }` */
  data?: Record<string, string>
}

export type AdminRender = (req: Request) => AdminPageContent | string | Promise<AdminPageContent | string>

/**
 * A link under a page in the sidebar.
 *
 * `href` is one of:
 * - `#name`, an anchor on the page itself, e.g. a tab the page's script shows on `hashchange`
 * - a path below the page, e.g. `players` → `<admin>/<page>/players/`. Give it a `render` for the layout to serve it
 * - an absolute path or URL, linked as is
 */
export interface AdminNavLink {
  label: string
  href: string
  /** Serve this sub page in the layout, when `href` is a path below the page */
  render?: AdminRender
}

/**
 * A page of the admin panel, with its entry in the sidebar.
 */
export interface AdminPage {
  /** Where it is under the admin panel, e.g. `monitoring` → `/admin/monitoring/`. `''` is the panel's start page */
  path: string
  /** Its name in the sidebar */
  label: string
  /** Sidebar heading it is listed under. Default `Server` for the engine's pages, `Plugins` for those of plugins */
  group?: string
  icon?: AdminIcon | string
  /** Lower first, within its group. Default 100 */
  order?: number
  /** Links shown under it in the sidebar while it is open */
  children?: AdminNavLink[]
  render: AdminRender
}

/** Checks a login of the admin panel's browser prompt, e.g. against an htpasswd file */
export type AdminLogin = (user: string, password: string) => boolean | Promise<boolean>

/**
 * The admin panel as a plugin sees it, `ctx.admin`: register pages in the shared layout and its sidebar.
 *
 * ```ts
 * http(app, ctx) {
 *   ctx.admin.page({ path: 'chat', label: 'Chat', icon: 'chat', render: () => '<p>Hello</p>' })
 *   app.get(ctx.admin.url('chat/api/messages'), handler) // already behind the admin login
 * }
 * ```
 */
export interface AdminApi {
  /** Where the panel is served, e.g. `/admin`, without a trailing slash */
  readonly path: string
  /** Whether it answers: it is off when turned off, and in production without the admin token or a login */
  readonly enabled: boolean
  /** Absolute path of `path` under the panel: `url('chat/api')` → `/admin/chat/api` */
  url(path?: string): string
  /** Add a page and its sidebar entry. A page registered again under the same path replaces the earlier one */
  page(page: AdminPage): void
  /**
   * The admin login, for routes outside the panel's path. Every route under `path` already sits behind it.
   * It takes the admin token as the browser prompt's password (any user name) or as `Authorization: Bearer`,
   * and every login added with `addLogin()`.
   */
  readonly guard: RequestHandler
  /** Let more people in than whoever has the admin token, e.g. the users of an htpasswd file */
  addLogin(login: AdminLogin): void
}
