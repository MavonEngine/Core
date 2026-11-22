import type { ServerPluginInfo } from '../../../Plugins/types'
import type { HttpRouteInfo } from '../Http/RouteInfo'
import type { ServerHealth } from '../Stats/ServerMetrics'
import type AdminPanel from './AdminPanel'
import { version } from '../../../version'
import { escapeHtml, iconHtml } from './layout'

export interface EnginePageSources {
  health(): ServerHealth
  routes(): HttpRouteInfo[]
  plugins?(): ServerPluginInfo[]
}

function formatUptime(seconds: number): string {
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  if (d)
    return `${d}d ${h}h`
  if (h)
    return `${h}h ${m}m`
  return `${m}m ${seconds % 60}s`
}

function card(label: string, value: unknown): string {
  return `<div class="adm-card"><h2>${escapeHtml(label)}</h2><div class="adm-stat">${escapeHtml(value ?? '—')}</div></div>`
}

function table(columns: string[], rows: string[][], empty: string): string {
  if (!rows.length)
    return `<p class="adm-muted">${escapeHtml(empty)}</p>`
  return `<div class="adm-table-wrap"><table class="adm-table"><thead><tr>${columns.map(c => `<th>${escapeHtml(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(row => `<tr>${row.map(cell => `<td>${cell}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`
}

/**
 * The engine's own pages of the admin panel: an overview of the server, its HTTP routes and its plugins.
 */
export function registerEnginePages(panel: AdminPanel, sources: EnginePageSources): void {
  panel.page({
    path: '',
    label: 'Overview',
    icon: 'dashboard',
    order: 0,
    render: () => {
      const health = sources.health()
      const others = panel.list().filter(page => page.path !== '')
      return `<div class="adm-page">
  <div class="adm-cards">
    ${card('Uptime', formatUptime(health.uptime))}
    ${card('Players', health.players)}
    ${card('Entities', health.world.entities)}
    ${card('Physics bodies', health.physics.bodies)}
    ${card('Engine', version)}
  </div>
  <h2 class="adm-group-label">Pages</h2>
  <div class="adm-cards">${others.map(page => `
    <a class="adm-card adm-card-link" href="${escapeHtml(panel.url(page.path))}/">
      <h2>${iconHtml(page.icon, page.label)}</h2>
      <div>${escapeHtml(page.label)}</div>
      <div class="adm-muted">${escapeHtml(page.plugin ?? 'engine')}</div>
    </a>`).join('')}
  </div>
</div>`
    },
  })

  panel.page({
    path: 'routes',
    label: 'Routes',
    icon: 'routes',
    order: 10,
    render: () => {
      const routes = sources.routes()
      return `<div class="adm-page">
  <p class="adm-muted">Every HTTP endpoint of this server: the engine's, the game's and those of plugins.</p>
  ${table(['Method', 'Path', 'From', 'What it does', 'Auth'], routes.map(route => [
    `<span class="adm-badge">${escapeHtml(route.method)}</span>`,
    `${escapeHtml(route.path)}${route.devOnly ? ' <span class="adm-badge adm-warning">dev</span>' : ''}`,
    escapeHtml(route.plugin ?? route.source),
    escapeHtml(route.summary ?? ''),
    `<span class="adm-muted">${escapeHtml(route.auth ?? '')}</span>`,
  ]), 'No routes')}
</div>`
    },
  })

  if (sources.plugins) {
    const plugins = sources.plugins
    panel.page({
      path: 'plugins',
      label: 'Plugins',
      icon: 'plugin',
      order: 20,
      render: () => `<div class="adm-page">
  ${table(['Package', 'Version', 'Status', 'Role', 'Description'], plugins().map((plugin) => {
    const status = !plugin.enabled
      ? '<span class="adm-muted">disabled</span>'
      : plugin.problem
        ? `<span class="adm-danger">${escapeHtml(plugin.problem)}</span>`
        : plugin.runningOnServer
          ? '<span class="adm-success">running</span>'
          : '<span class="adm-muted">not on the server</span>'
    const roles = (['database', 'auth', 'notifications'] as const).filter(role => plugin[role]).map(role => `<span class="adm-badge">${role}</span>`).join(' ')
    return [escapeHtml(plugin.package), escapeHtml(plugin.version ?? ''), status, roles, `<span class="adm-muted">${escapeHtml(plugin.description ?? '')}</span>`]
  }), 'No plugins')}
</div>`,
    })
  }
}
