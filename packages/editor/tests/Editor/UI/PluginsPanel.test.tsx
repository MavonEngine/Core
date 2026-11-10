// @vitest-environment jsdom

import type { PluginInfo } from '../../../src/Editor/Plugins/pluginsApi'
import type { HttpRouteInfo } from '../../../src/Editor/Server/routesApi'
import { registerPrefab, unregisterPrefab } from '@mavonengine/core/Prefab/PrefabRegistry'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PluginsPanel from '../../../src/Editor/UI/Plugins/PluginsPanel'

vi.mock('../../../src/Editor/UI/Plugins/PluginsPanel.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('../../../src/Editor/UI/Plugins/Markdown.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))
vi.mock('../../../src/Editor/UI/Server/ServerPanel.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))

const PLUGINS: PluginInfo[] = [
  {
    package: '@acme/forest',
    enabled: true,
    installed: true,
    version: '2.3.1',
    description: 'Trees and rocks',
    license: 'MIT',
    homepage: 'git+https://example.com/forest.git',
    target: 'both',
    engine: '^0.1.0',
    readme: '# Forest\n\nPlants **trees**.',
    declaredPrefabs: ['Tree', 'Rock'],
    usedPrefabs: ['Tree'],
  },
  { package: 'chat', enabled: false, installed: true, version: '1.0.0', target: 'server', declaredPrefabs: [], usedPrefabs: [] },
  { package: 'ghost', enabled: true, installed: false, problem: 'Listed in mavonengine.json but not installed', declaredPrefabs: [], usedPrefabs: [] },
]

const ROUTES: HttpRouteInfo[] = [
  { method: 'GET', path: '/api/game/health', source: 'engine', params: {}, devOnly: false },
  { method: 'GET', path: '/forest/trees', source: 'plugin', plugin: '@acme/forest', params: {}, devOnly: false, summary: 'Every tree' },
  { method: 'POST', path: '/forest/grow', source: 'plugin', plugin: '@acme/forest', params: {}, devOnly: true },
]

function json(body: unknown) {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
}

/** The dev server lists the plugins, the game server its routes */
function servers({ plugins = PLUGINS, routes = ROUTES as HttpRouteInfo[] | null } = {}) {
  return vi.fn(async (url: RequestInfo | URL) => {
    if (String(url).endsWith('/__mavonengine/plugins'))
      return json({ root: '/project', plugins })
    if (routes)
      return json({ routes })
    return new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
  }) as unknown as typeof fetch
}

function rows(table: HTMLElement) {
  return within(table).getAllByRole('row').slice(1).map(row => Array.from(row.querySelectorAll('td'), cell => cell.textContent))
}

beforeEach(() => {
  registerPrefab({ name: 'Tree', label: 'Pine tree', plugin: '@acme/forest', spawn: () => {} })
})

afterEach(() => {
  cleanup()
  unregisterPrefab('@acme/forest:Tree')
})

describe('pluginsPanel', () => {
  it('lists the project\'s plugins and shows the first one', async () => {
    render(<PluginsPanel fetchFn={servers()} />)

    await screen.findByText('Plugins (3)')
    const items = within(screen.getByRole('list', { name: 'Plugins' })).getAllByRole('button')
    expect(items.map(item => item.textContent)).toEqual(['@acme/forestv2.3.1', 'chatDisabled', 'ghostProblem'])
    expect(items[0].getAttribute('aria-current')).toBe('true')

    screen.getByRole('heading', { name: '@acme/forest' })
    screen.getByText('v2.3.1', { selector: '.badge' })
    screen.getByText('Enabled')
    screen.getByText('Client + server')
    screen.getByText('Trees and rocks')
    screen.getByText('@mavonengine/core ^0.1.0')
    screen.getByText('MIT')
    expect(screen.getByText('https://example.com/forest').getAttribute('href')).toBe('https://example.com/forest')
  })

  it('shows the endpoints and prefabs that come from the plugin, and its readme', async () => {
    render(<PluginsPanel fetchFn={servers()} />)
    await screen.findByText('Plugins (3)')
    const [endpoints, prefabs] = screen.getAllByRole('table')

    expect(rows(endpoints)).toEqual([
      ['GET', '/forest/trees', 'Prod + dev', 'Every tree'],
      ['POST', '/forest/grow', 'Dev only', ''],
    ])
    expect(rows(prefabs)).toEqual([
      ['Pine tree (Tree)', 'Can be placed from Assets', 'Yes, its assets ship in a release'],
      ['Rock', 'Not registered in this session', 'No, its assets are left out of a release'],
    ])

    // The readme, with its title one level below the plugin's name
    expect(screen.getByRole('heading', { name: 'Forest', level: 2 })).toBeTruthy()
    expect(screen.getByText('trees').tagName).toBe('STRONG')
  })

  it('switches to the plugin that is picked', async () => {
    render(<PluginsPanel fetchFn={servers()} />)
    await screen.findByText('Plugins (3)')

    fireEvent.click(screen.getByText('chat'))

    screen.getByRole('heading', { name: 'chat' })
    screen.getByText('Disabled', { selector: '.badge' })
    screen.getByText('It registered no HTTP endpoints on the game server.')
    screen.getByText('It has no prefabs.')
    screen.getByText('The package has no readme.')
  })

  it('says what is wrong with a plugin that can\'t be used', async () => {
    render(<PluginsPanel fetchFn={servers()} />)
    await screen.findByText('Plugins (3)')

    fireEvent.click(screen.getByText('ghost'))

    expect(screen.getByRole('alert').textContent).toBe('Listed in mavonengine.json but not installed')
  })

  it('still shows the plugins of a game without a server, with their endpoints unknown', async () => {
    render(<PluginsPanel fetchFn={servers({ routes: null })} />)

    await screen.findByText('Plugins (3)')
    expect(screen.getByText(/^Unknown: /).textContent).toContain('no game server')
    // The prefabs don't need the server
    expect(screen.getAllByRole('table')).toHaveLength(1)
  })

  it('says so when the project has no plugins', async () => {
    render(<PluginsPanel fetchFn={servers({ plugins: [] })} />)

    await screen.findByText('Plugins (0)')
    screen.getByText(/This project has no plugins/)
  })

  it('shows why there is no list, and recovers on refresh', async () => {
    const fetchFn = vi.fn(async () => new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    render(<PluginsPanel fetchFn={fetchFn as unknown as typeof fetch} />)

    expect((await screen.findByRole('alert')).textContent).toContain('mavonEnginePlugins()')

    fetchFn.mockImplementation(servers() as any)
    fireEvent.click(screen.getByText('Refresh'))

    await screen.findByText('Plugins (3)')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
