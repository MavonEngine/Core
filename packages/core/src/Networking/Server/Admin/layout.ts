import type { AdminPageContent } from './types'

const HTML_ESCAPES: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  '\'': '&#39;',
}
const HTML_ESCAPE_RE = /[&<>"']/g
const DATA_KEY_RE = /^[a-z][a-z0-9-]*$/

/** Text made safe to put into HTML, also inside attribute values */
export function escapeHtml(value: unknown): string {
  return String(value ?? '').replace(HTML_ESCAPE_RE, char => HTML_ESCAPES[char])
}

/** 24×24 stroke icons, drawn in the link's text color */
const ICONS: Record<string, string> = {
  dashboard: '<rect x="3" y="3" width="7" height="9" rx="1"/><rect x="14" y="3" width="7" height="5" rx="1"/><rect x="14" y="12" width="7" height="9" rx="1"/><rect x="3" y="16" width="7" height="5" rx="1"/>',
  activity: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  routes: '<circle cx="6" cy="19" r="3"/><circle cx="18" cy="5" r="3"/><path d="M9 19h8.5a3.5 3.5 0 0 0 0-7h-11a3.5 3.5 0 0 1 0-7H15"/>',
  plugin: '<path d="M12 2v4M8 2v4M16 2v4"/><rect x="5" y="6" width="14" height="8" rx="2"/><path d="M12 14v4a4 4 0 0 1-4 4"/>',
  database: '<ellipse cx="12" cy="5" rx="8" ry="3"/><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
  users: '<circle cx="9" cy="8" r="4"/><path d="M2 21v-1a6 6 0 0 1 6-6h2a6 6 0 0 1 6 6v1"/><path d="M16 3.1a4 4 0 0 1 0 7.8M22 21v-1a6 6 0 0 0-4-5.6"/>',
  logs: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6M8 13h8M8 17h8M8 9h2"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>',
  chart: '<path d="M3 3v18h18"/><path d="M7 15l4-4 3 3 5-6"/>',
  mail: '<rect x="2" y="4" width="20" height="16" rx="2"/><path d="M22 6l-10 7L2 6"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
  bell: '<path d="M18 8a6 6 0 0 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0"/>',
  lock: '<rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/>',
}

export function iconHtml(icon: string | undefined, label: string): string {
  const paths = icon ? ICONS[icon] : undefined
  if (paths)
    return `<svg class="adm-icon" viewBox="0 0 24 24" aria-hidden="true">${paths}</svg>`
  return `<span class="adm-icon adm-icon-letter" aria-hidden="true">${escapeHtml((label.trim()[0] ?? '?').toUpperCase())}</span>`
}

export interface LayoutNavLink {
  label: string
  href: string
  /** Set on `#anchor` links, which the layout's script marks as current */
  hash?: string
  current: boolean
}

export interface LayoutNavItem {
  label: string
  href: string
  icon?: string
  current: boolean
  children: LayoutNavLink[]
}

export interface LayoutNavGroup {
  label: string
  items: LayoutNavItem[]
}

export interface LayoutOptions {
  /** The panel's path, e.g. `/admin` */
  base: string
  /** Shown next to the brand, e.g. the game's name */
  appName?: string
  nav: LayoutNavGroup[]
  content: AdminPageContent
  title: string
}

function renderNav(groups: LayoutNavGroup[]): string {
  return groups.map(group => `
      <div class="adm-group">
        <h2 class="adm-group-label">${escapeHtml(group.label)}</h2>
        <ul class="adm-nav">${group.items.map(item => `
          <li>
            <a class="adm-link" href="${escapeHtml(item.href)}"${item.current ? ' aria-current="page"' : ''}>${iconHtml(item.icon, item.label)}<span>${escapeHtml(item.label)}</span></a>${item.current && item.children.length
              ? `
            <ul class="adm-subnav">${item.children.map(child => `
              <li><a href="${escapeHtml(child.href)}"${child.hash
                ? ` data-hash="${escapeHtml(child.hash)}"`
                : ''}${child.current ? ' aria-current="page"' : ''}>${escapeHtml(child.label)}</a></li>`).join('')}
            </ul>`
              : ''}
          </li>`).join('')}
        </ul>
      </div>`).join('')
}

/**
 * The admin panel's page: the sidebar, the top bar and the page's content.
 */
export function renderLayout({ base, appName, nav, content, title }: LayoutOptions): string {
  const data = Object.entries(content.data ?? {})
    .filter(([key]) => DATA_KEY_RE.test(key))
    .map(([key, value]) => ` data-${key}="${escapeHtml(value)}"`)
    .join('')

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex, nofollow">
  <title>${escapeHtml(title)} · ${escapeHtml(appName || 'MavonEngine')} admin</title>
  <link rel="stylesheet" href="${base}/_admin/admin.css">${(content.styles ?? []).map(href => `
  <link rel="stylesheet" href="${escapeHtml(href)}">`).join('')}
  <script type="module" src="${base}/_admin/admin.js"></script>
</head>
<body class="adm"${data}>
  <div class="adm-shell">
    <aside class="adm-sidebar" id="adm-sidebar">
      <a class="adm-brand" href="${base}/">
        <span class="adm-brand-name">MavonEngine</span>
        <span class="adm-brand-app">${escapeHtml(appName || 'admin')}</span>
      </a>
      <nav aria-label="Admin">${renderNav(nav)}
      </nav>
    </aside>
    <div class="adm-backdrop" id="adm-backdrop" hidden></div>
    <div class="adm-main">
      <header class="adm-topbar">
        <button type="button" class="adm-menu" id="adm-menu" aria-controls="adm-sidebar" aria-expanded="false" aria-label="Menu">
          <svg class="adm-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M3 6h18M3 12h18M3 18h18"/></svg>
        </button>
        <h1 class="adm-title">${escapeHtml(title)}</h1>
      </header>
      <div class="adm-content" id="adm-content">
${content.html}
      </div>
    </div>
  </div>${(content.scripts ?? []).map(src => `
  <script type="module" src="${escapeHtml(src)}"></script>`).join('')}
</body>
</html>
`
}

/**
 * The layout's script: opens the sidebar on small screens and marks the `#anchor` link of the page that is shown.
 */
export const ADMIN_SCRIPT = `const sidebar = document.getElementById('adm-sidebar')
const menu = document.getElementById('adm-menu')
const backdrop = document.getElementById('adm-backdrop')

function setOpen(open) {
  sidebar.classList.toggle('open', open)
  backdrop.hidden = !open
  menu.setAttribute('aria-expanded', String(open))
}

menu.addEventListener('click', () => setOpen(!sidebar.classList.contains('open')))
backdrop.addEventListener('click', () => setOpen(false))
document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape')
    setOpen(false)
})

const anchors = [...document.querySelectorAll('.adm-subnav a[data-hash]')]

function markAnchor() {
  if (!anchors.length)
    return
  const hash = location.hash.slice(1)
  const current = anchors.find(a => a.dataset.hash === hash) ?? anchors[0]
  for (const a of anchors) {
    if (a === current)
      a.setAttribute('aria-current', 'page')
    else
      a.removeAttribute('aria-current')
  }
}

for (const a of anchors)
  a.addEventListener('click', () => setOpen(false))

window.addEventListener('hashchange', markAnchor)
markAnchor()
`
