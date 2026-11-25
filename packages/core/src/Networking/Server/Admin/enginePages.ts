import type { ServerPluginInfo } from '../../../Plugins/types'
import type { HttpRouteInfo } from '../Http/RouteInfo'
import type { ServerHealth } from '../Stats/ServerMetrics'
import type WorldInspector from '../Stats/WorldInspector'
import type AdminPanel from './AdminPanel'
import process from 'node:process'
import { version as rapierVersion } from '@dimforge/rapier3d-compat'
import { REVISION as THREE_REVISION } from 'three'
import { version } from '../../../version'
import { escapeHtml, iconHtml } from './layout'

export interface EnginePageSources {
  health(): ServerHealth
  routes(): HttpRouteInfo[]
  plugins?(): ServerPluginInfo[]
  /** The server's three.js scene graph and its physics world */
  inspector?: Pick<WorldInspector, 'sceneGraph' | 'physics'>
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

/** A card with a title and key-value pairs. Values are HTML, escape what isn't */
function valuesCard(title: string, pairs: [string, string][], extra = ''): string {
  return `<section class="adm-card"><h2>${escapeHtml(title)}</h2><dl class="adm-values">${pairs.map(([key, value]) => `<dt>${escapeHtml(key)}</dt><dd>${value}</dd>`).join('')}</dl>${extra}</section>`
}

const muted = (text: string) => `<span class="adm-muted">${escapeHtml(text)}</span>`
const formatNumber = (n: number) => n.toLocaleString('en-US')
const formatVector = ({ x, y, z }: { x: number, y: number, z: number }) => [x, y, z].map(n => Number(n.toFixed(3))).join(', ')

/** Rapier's version, which its WebAssembly module answers: undefined before `RAPIER.init()` */
function rapierVersionOrUndefined(): string | undefined {
  try {
    return rapierVersion()
  }
  catch {
    return undefined
  }
}

function runtimeCard(sources: EnginePageSources): string {
  const physics = sources.inspector?.physics()
  const rapier = physics
    ? rapierVersionOrUndefined()
    : undefined
  return valuesCard('Runtime', [
    [
      'Engine',
      escapeHtml(version),
    ],
    ['Three.js', `r${escapeHtml(THREE_REVISION)}`],
    [
      'Rapier',
      physics
        ? (rapier
            ? escapeHtml(rapier)
            : 'in use')
        : muted('not used on the server'),
    ],
    [
      'Node.js',
      escapeHtml(process.version),
    ],
    [
      'Mode',
      escapeHtml(process.env.NODE_ENV || 'development'),
    ],
    [
      'Platform',
      escapeHtml(`${process.platform} ${process.arch}`),
    ],
  ])
}

function sceneGraphCard(sources: EnginePageSources): string {
  const graph = sources.inspector?.sceneGraph()
  if (!graph)
    return ''
  const types = Object.entries(graph.byType)
  return valuesCard('Server scene graph (three.js)', [
    [
      'Objects',
      formatNumber(graph.objects),
    ],
    [
      'Meshes',
      formatNumber(graph.meshes),
    ],
    [
      'Triangles',
      formatNumber(graph.triangles),
    ],
    [
      'Lights',
      formatNumber(graph.lights),
    ],
    ...types.slice(0, 6).map(([type, count]): [string, string] => [
      type,
      formatNumber(count),
    ]),
    ...(types.length > 6
      ? [
          [
            'Other types',
            formatNumber(types.slice(6).reduce((sum, [, count]) => sum + count, 0)),
          ] as [string, string],
        ]
      : []),
  ])
}

function physicsCard(sources: EnginePageSources): string {
  if (!sources.inspector)
    return ''
  const physics = sources.inspector.physics()
  if (!physics)
    return `<section class="adm-card"><h2>Physics (Rapier)</h2><p class="adm-muted">The server runs without a physics world.</p></section>`
  return valuesCard('Physics (Rapier)', [
    [
      'Bodies',
      formatNumber(physics.bodies),
    ],
    [
      'Dynamic',
      formatNumber(physics.dynamic),
    ],
    [
      'Fixed',
      formatNumber(physics.fixed),
    ],
    [
      'Kinematic',
      formatNumber(physics.kinematic),
    ],
    ['Sleeping', `${formatNumber(physics.sleeping)} ${muted(`of ${physics.bodies}`)}`],
    [
      'Colliders',
      formatNumber(physics.colliders),
    ],
    [
      'Gravity',
      escapeHtml(formatVector(physics.gravity)),
    ],
    ['Timestep', `${Number((physics.timestep * 1000).toFixed(2))} ms`],
  ])
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
  </div>
  <div class="adm-sections">
    ${runtimeCard(sources)}
    ${sceneGraphCard(sources)}
    ${physicsCard(sources)}
  </div>
  <h2 class="adm-section-title">Pages</h2>
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
  ${table([
    'Method',
    'Path',
    'From',
    'What it does',
    'Auth',
  ], routes.map(route => [
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
  ${table([
    'Package',
    'Version',
    'Status',
    'Role',
    'Description',
  ], plugins().map((plugin) => {
    const status = !plugin.enabled
      ? '<span class="adm-muted">disabled</span>'
      : plugin.problem
        ? `<span class="adm-danger">${escapeHtml(plugin.problem)}</span>`
        : plugin.runningOnServer
          ? '<span class="adm-success">running</span>'
          : '<span class="adm-muted">not on the server</span>'
    const roles = (['database', 'auth', 'notifications'] as const).filter(role => plugin[role]).map(role => `<span class="adm-badge">${role}</span>`).join(' ')
    return [
      escapeHtml(plugin.package),
      escapeHtml(plugin.version ?? ''),
      status,
      roles,
      `<span class="adm-muted">${escapeHtml(plugin.description ?? '')}</span>`,
    ]
  }), 'No plugins')}
</div>`,
    })
  }
}
