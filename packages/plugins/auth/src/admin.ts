import type { AdminApi } from '@mavonengine/core/Plugins/types'
import type { Express, Request, RequestHandler, Response } from 'express'
import type AuthStore from './store'
import type { AccountListing, AccountQuery } from './store'
import { escapeHtml } from './pages'

/**
 * The plugin's pages in the game server's admin panel (`/admin/accounts/`): every account with how it logs in, its
 * sessions and whether it is online, searchable, with buttons to disable, enable and log out. Plain HTML forms, no
 * script, behind the panel's login.
 */

export interface AdminPageDeps {
  /** The accounts, undefined while the plugin has no database */
  store(): AuthStore | undefined
  disable(accountId: string): Promise<boolean>
  enable(accountId: string): Promise<boolean>
  endSessions(accountId: string): Promise<number>
  /** Open game connections of an account */
  online(accountId: string): number
  /** Open game connections of every account */
  onlineTotal(): number
  logger?: { info(message: string): void, warn(message: string): void } | null
}

export const ADMIN_PAGE = 'accounts'
export const PAGE_SIZE = 50

const MAX_FORM_BYTES = 4096
const ACTIONS = ['disable', 'enable', 'logout'] as const
type Action = typeof ACTIONS[number]

const NOTICES: Record<string, (req: Request) => { text: string, error?: boolean }> = {
  'disabled': () => ({ text: 'The account is disabled: its sessions ended and its game connections closed.' }),
  'enabled': () => ({ text: 'The account can log in again.' }),
  'logged-out': (req) => {
    const ended = Math.max(0, Number(req.query.ended) || 0)
    return { text: `Logged out everywhere: ${ended} session${ended === 1
      ? ''
      : 's'} ended.` }
  },
  'missing': () => ({ text: 'There is no such account any more.', error: true }),
  'unavailable': () => ({ text: 'Accounts are unavailable: the auth plugin has no database.', error: true }),
}

/** Registered symbol core reads a route's description from */
const ROUTE_DOC = Symbol.for('mavonengine.routeDoc')

function describe(doc: { summary: string, description?: string, params?: Record<string, string>, response?: string }): RequestHandler {
  const handler: RequestHandler = (_req, _res, next) => next()
  ;(handler as unknown as Record<symbol, unknown>)[ROUTE_DOC] = doc
  return handler
}

/** `2026-11-22 10:04`, in UTC, or a dash */
function formatTime(iso: string | null): string {
  if (!iso)
    return '<span class="adm-muted">—</span>'
  return `<time class="adm-nowrap" datetime="${escapeHtml(iso)}" title="${escapeHtml(iso)}">${escapeHtml(iso.slice(0, 16).replace('T', ' '))}</time>`
}

function badge(text: string, cls = ''): string {
  return `<span class="adm-badge${cls
    ? ` ${cls}`
    : ''}">${escapeHtml(text)}</span>`
}

function card(label: string, value: number): string {
  return `<div class="adm-card"><h2>${escapeHtml(label)}</h2><div class="adm-stat">${value}</div></div>`
}

function queryString(params: Record<string, string | number | undefined>): string {
  const query = new URLSearchParams()
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== '' && value !== 0)
      query.set(key, String(value))
  }
  const text = query.toString()
  return text
    ? `?${text}`
    : ''
}

/**
 * Whether a form post came from the panel itself. The panel logs in with HTTP Basic auth, which the browser sends
 * with any request to the server, also one another site makes it send: without this, a page elsewhere could disable
 * accounts in the name of a logged in admin. Tools that send neither header aren't browsers and pass.
 */
export function sameOrigin(req: Request): boolean {
  // What browsers say about where a request comes from. Trusted over Origin, which the panel's
  // `Referrer-Policy: no-referrer` turns into `null` on its own form posts
  const site = req.headers['sec-fetch-site']
  if (site)
    return site === 'same-origin' || site === 'none'

  // Older browsers: Origin, when they send one. `null` can't be told apart from another site's
  const origin = req.headers.origin
  if (!origin)
    return true
  try {
    return new URL(origin).host === req.headers.host
  }
  catch {
    return false
  }
}

function readForm(req: Request): Promise<Record<string, string>> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      raw += chunk
      if (raw.length > MAX_FORM_BYTES) {
        reject(new Error('Form too large'))
        req.destroy()
      }
    })
    req.on('end', () => resolve(Object.fromEntries(new URLSearchParams(raw))))
    req.on('error', reject)
  })
}

function accountRow(account: AccountListing, online: number, actionBase: string, back: string): string {
  const action = (name: Action, label: string, cls = '') => `<form class="adm-inline-form" method="post" action="${escapeHtml(`${actionBase}/${encodeURIComponent(account.id)}/${name}`)}">
          <input type="hidden" name="back" value="${escapeHtml(back)}">
          <button type="submit" class="adm-button${cls
            ? ` ${cls}`
            : ''}">${escapeHtml(label)}</button>
        </form>`

  const login = [
    account.username
      ? escapeHtml(account.username)
      : '',
    ...account.providers.filter(provider => provider !== 'password').map(provider => badge(provider)),
  ].filter(Boolean).join(' ') || '<span class="adm-muted">—</span>'

  const email = account.email
    ? `${escapeHtml(account.email)} ${account.emailVerifiedAt
      ? badge('verified', 'adm-success')
      : badge('unverified', 'adm-muted')}`
    : '<span class="adm-muted">—</span>'

  const status = account.disabledAt
    ? `${badge('disabled', 'adm-danger')}`
    : online > 0
      ? badge('online', 'adm-success')
      : '<span class="adm-muted">offline</span>'

  return `<tr>
      <td>${escapeHtml(account.name)}${account.guest
        ? ` ${badge('guest', 'adm-warning')}`
        : ''}<br><span class="adm-muted adm-small">${escapeHtml(account.id)}</span></td>
      <td>${login}</td>
      <td>${email}</td>
      <td>${account.sessions}</td>
      <td>${status}</td>
      <td>${formatTime(account.createdAt)}</td>
      <td>${formatTime(account.lastLoginAt)}</td>
      <td><div class="adm-actions">
        ${account.disabledAt
          ? action('enable', 'Enable')
          : action('disable', 'Disable', 'adm-button-danger')}
        ${account.sessions > 0 || online > 0
          ? action('logout', 'Log out')
          : ''}
      </div></td>
    </tr>`
}

async function renderAccounts(req: Request, admin: AdminApi, deps: AdminPageDeps, filter?: AccountQuery['filter']): Promise<{ html: string, title?: string }> {
  const store = deps.store()
  if (!store) {
    return { html: `<div class="adm-page"><p class="adm-notice adm-danger">Accounts are unavailable: the auth plugin has no database. Install a database plugin such as <code>@mavonengine/sqlite</code>.</p></div>` }
  }

  const search = typeof req.query.q === 'string'
    ? req.query.q.trim().slice(0, 200)
    : ''
  const offset = Math.max(0, Math.floor(Number(req.query.offset) || 0))
  const pageUrl = `${admin.url(filter
    ? `${ADMIN_PAGE}/${filter}`
    : ADMIN_PAGE)}/`
  const [{ accounts, total }, stats] = await Promise.all([
    store.listAccounts(PAGE_SIZE, offset, { search: search || undefined, filter }),
    store.stats(),
  ])

  const notice = typeof req.query.notice === 'string'
    ? NOTICES[req.query.notice]?.(req)
    : undefined
  // Where an action sends the admin back to: this page as it is, without the notice of the last action
  const back = `${pageUrl}${queryString({ q: search, offset })}`
  const actionBase = admin.url(`${ADMIN_PAGE}/actions`)

  const from = total === 0
    ? 0
    : offset + 1
  const to = Math.min(total, offset + accounts.length)
  const previous = offset > 0
    ? `${pageUrl}${queryString({
      q: search,
      offset: Math.max(0, offset - PAGE_SIZE),
    })}`
    : undefined
  const next = to < total
    ? `${pageUrl}${queryString({ q: search, offset: offset + PAGE_SIZE })}`
    : undefined
  const pagerLink = (href: string | undefined, label: string) => href
    ? `<a class="adm-button" href="${escapeHtml(href)}">${label}</a>`
    : `<a class="adm-button" aria-disabled="true">${label}</a>`

  const empty = search
    ? `No accounts match “${escapeHtml(search)}”.`
    : filter === 'guests'
      ? 'No guest accounts.'
      : filter === 'disabled'
        ? 'No disabled accounts.'
        : 'No accounts yet.'

  const html = `<div class="adm-page">
  ${notice
    ? `<p class="adm-notice${notice.error ? ' adm-danger' : ''}">${escapeHtml(notice.text)}</p>`
    : ''}
  ${filter
    ? ''
    : `<div class="adm-cards">
    ${card('Accounts', stats.accounts)}
    ${card('Online now', deps.onlineTotal())}
    ${card('Live sessions', stats.sessions)}
    ${card('Guests', stats.guests)}
    ${card('Disabled', stats.disabled)}
  </div>`}
  <form class="adm-toolbar" method="get" action="${escapeHtml(pageUrl)}" role="search">
    <input class="adm-input" type="search" name="q" value="${escapeHtml(search)}" placeholder="Name, email, username or id" aria-label="Search accounts">
    <button type="submit" class="adm-button adm-button-primary">Search</button>
    ${search
      ? `<a class="adm-button" href="${escapeHtml(pageUrl)}">Clear</a>`
      : ''}
    <span class="adm-spacer"></span>
    <span class="adm-muted">${from}–${to} of ${total}</span>
  </form>
  ${accounts.length
    ? `<div class="adm-table-wrap"><table class="adm-table">
    <thead><tr><th>Name</th><th>Login</th><th>Email</th><th>Sessions</th><th>Status</th><th>Created</th><th>Last login</th><th></th></tr></thead>
    <tbody>
    ${accounts.map(account => accountRow(account, deps.online(account.id), actionBase, back)).join('\n    ')}
    </tbody>
  </table></div>`
    : `<p class="adm-muted">${empty}</p>`}
  ${previous || next
    ? `<div class="adm-pager">${pagerLink(previous, '← Newer')}${pagerLink(next, 'Older →')}</div>`
    : ''}
</div>`

  return { html }
}

/**
 * Add the Accounts page, with Guests and Disabled below it, and the routes its buttons post to.
 */
export function mountAdminPages(app: Express, admin: AdminApi, deps: AdminPageDeps): void {
  const base = admin.url(ADMIN_PAGE)

  admin.page({
    path: ADMIN_PAGE,
    label: 'Accounts',
    icon: 'users',
    order: 20,
    children: [
      {
        label: 'Guests',
        href: 'guests',
        render: req => renderAccounts(req, admin, deps, 'guests'),
      },
      {
        label: 'Disabled',
        href: 'disabled',
        render: req => renderAccounts(req, admin, deps, 'disabled'),
      },
    ],
    render: req => renderAccounts(req, admin, deps),
  })

  // Under the panel's path, so behind its login already
  app.post(`${base}/actions/:id/:action`, describe({
    summary: 'An admin panel button: disable, enable or log out an account',
    params: { id: 'Id of the account', action: '`disable`, `enable` or `logout`' },
    response: 'A redirect back to the page the button was on',
  }), (req: Request, res: Response) => {
    void (async () => {
      const action = req.params.action as Action
      if (!ACTIONS.includes(action)) {
        res.status(404).type('text/plain').send('Unknown action\n')
        return
      }
      if (!sameOrigin(req)) {
        deps.logger?.warn(`Auth: refused an admin panel action from another site (${req.headers.origin ?? req.headers['sec-fetch-site']})`)
        res.status(403).type('text/plain').send('Only the admin panel can do that\n')
        return
      }

      const form = await readForm(req)
      // Only back to a page of this plugin's: anything else would make this an open redirect
      const back = typeof form.back === 'string' && form.back.startsWith(`${base}/`) && !form.back.includes('\\')
        ? form.back
        : `${base}/`
      const goBack = (params: Record<string, string | number>) => {
        const url = new URL(back, 'http://panel')
        url.searchParams.delete('notice')
        url.searchParams.delete('ended')
        for (const [key, value] of Object.entries(params))
          url.searchParams.set(key, String(value))
        res.redirect(303, `${url.pathname}${url.search}`)
      }

      if (!deps.store()) {
        goBack({ notice: 'unavailable' })
        return
      }

      const id = String(req.params.id)
      if (action === 'logout') {
        const ended = await deps.endSessions(id)
        deps.logger?.info(`Auth: logged account ${id} out everywhere from the admin panel`)
        goBack({ notice: 'logged-out', ended })
        return
      }

      const found = action === 'disable'
        ? await deps.disable(id)
        : await deps.enable(id)
      if (!found) {
        goBack({ notice: 'missing' })
        return
      }
      deps.logger?.info(`Auth: ${action}d account ${id} from the admin panel`)
      goBack({ notice: `${action}d` })
    })().catch((err: unknown) => {
      deps.logger?.warn(`Auth: an admin panel action failed: ${(err as Error)?.message ?? err}`)
      if (!res.headersSent)
        res.status(500).type('text/plain').send('Something went wrong\n')
    })
  })
}
