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
vi.mock('../../../src/Editor/UI/Plugins/InstallDialog.module.css', () => ({
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

const AVAILABLE = [
  { package: '@acme/forest', name: 'Forest', description: 'Trees and rocks', target: 'both' },
  { package: '@acme/weather', name: 'Weather', description: 'Rain and fog', target: 'both', engine: '>=0.1.0', homepage: 'https://example.com/weather', readme: 'https://raw.githubusercontent.com/acme/weather/main/README.md' },
  { package: 'plain' },
]

/** The dev server lists the plugins, the game server its routes, GitHub the plugins that can be installed */
function servers({ plugins = PLUGINS, routes = ROUTES as HttpRouteInfo[] | null, available = AVAILABLE as object[] | null, readme = '# Weather\n\nMakes it **rain**.' as string | null, install = undefined as object | undefined } = {}) {
  return vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url).endsWith('/__mavonengine/plugin-install')) {
      if (init?.method === 'POST')
        return new Response(JSON.stringify({ job: { id: 1, packages: JSON.parse(String(init.body)).packages, status: 'installing', output: '' } }), { status: 202, headers: { 'content-type': 'application/json' } })
      return install ? json(install) : new Response('<html></html>', { status: 200, headers: { 'content-type': 'text/html' } })
    }
    if (String(url).endsWith('/__mavonengine/plugins'))
      return json({ root: '/project', plugins })
    if (String(url).endsWith('/README.md'))
      return readme === null ? new Response('Not Found', { status: 404 }) : new Response(readme)
    if (String(url).startsWith('https://raw.githubusercontent.com/'))
      return available ? json({ version: 1, plugins: available }) : new Response('Not Found', { status: 404 })
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
  localStorage.clear()
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

  it('says so when the project has no plugins, and shows the first one it could install', async () => {
    render(<PluginsPanel fetchFn={servers({ plugins: [] })} />)

    await screen.findByText('Plugins (0)')
    screen.getByText(/This project has no plugins/)
    await screen.findByText('Available to install (3)')
    screen.getByRole('heading', { name: 'Forest' })
    screen.getByText('npx @mavonengine/cli install @acme/forest')
  })

  describe('available to install', () => {
    it('lists the plugins from GitHub that the project doesn\'t have yet', async () => {
      const fetchFn = servers()
      render(<PluginsPanel fetchFn={fetchFn} />)

      await screen.findByText('Available to install (2)')
      const items = within(screen.getByRole('list', { name: 'Available plugins' })).getAllByRole('button')
      expect(items.map(item => item.textContent)).toEqual(['@acme/weatherRain and fog', 'plainplain'])
      expect(fetchFn).toHaveBeenCalledWith('https://raw.githubusercontent.com/MavonEngine/Core/main/plugins.json', expect.objectContaining({ cache: 'no-store' }))

      // The project's first plugin is still the one shown
      screen.getByRole('heading', { name: '@acme/forest' })
    })

    it('shows what a plugin is and how to install it when it is picked', async () => {
      render(<PluginsPanel fetchFn={servers()} />)

      fireEvent.click(await screen.findByText('@acme/weather'))

      screen.getByRole('heading', { name: 'Weather' })
      screen.getByText('Not installed')
      screen.getByText('Client + server')
      screen.getByText('@mavonengine/core >=0.1.0')
      expect(screen.getByText('https://example.com/weather').getAttribute('href')).toBe('https://example.com/weather')
      screen.getByText('npx @mavonengine/cli install @acme/weather')
      // Nothing about endpoints or prefabs of something that isn't there
      expect(screen.queryByRole('table')).toBeNull()

      fireEvent.click(screen.getByText('chat'))
      screen.getByRole('heading', { name: 'chat' })
    })

    it('shows the readme the list points to, read when the plugin is looked at', async () => {
      const fetchFn = servers()
      render(<PluginsPanel fetchFn={fetchFn} />)
      await screen.findByText('Available to install (2)')
      expect(fetchFn).not.toHaveBeenCalledWith('https://raw.githubusercontent.com/acme/weather/main/README.md', expect.anything())

      fireEvent.click(screen.getByText('@acme/weather'))

      expect((await screen.findByText('rain')).tagName).toBe('STRONG')
      expect(fetchFn).toHaveBeenCalledWith('https://raw.githubusercontent.com/acme/weather/main/README.md', expect.objectContaining({ cache: 'no-store' }))

      // A plugin the list gives no readme for
      fireEvent.click(screen.getByText('plain', { selector: '.itemName' }))
      screen.getByText('The list of plugins has no readme for it.')
      expect(screen.queryByText('rain')).toBeNull()
    })

    it('says so when the readme can\'t be read', async () => {
      render(<PluginsPanel fetchFn={servers({ readme: null })} />)

      fireEvent.click(await screen.findByText('@acme/weather'))

      expect((await screen.findByText(/^Could not read its readme: /)).textContent).toContain('was not found')
      // The rest is still there
      screen.getByText('npx @mavonengine/cli install @acme/weather')
    })

    describe('installing', () => {
      const canInstall = { available: true, job: null }

      it('offers to install a plugin under mavonengine dev, and asks first', async () => {
        const fetchFn = servers({ install: canInstall })
        render(<PluginsPanel fetchFn={fetchFn} />)
        fireEvent.click(await screen.findByText('@acme/weather'))

        fireEvent.click(await screen.findByRole('button', { name: 'Install @acme/weather…' }))

        // Nothing is installed by the click: the dialog has to be answered
        screen.getByRole('dialog', { name: 'Install @acme/weather?' })
        expect(screen.getByText('https://example.com/weather', { selector: '.sources a' })).toBeTruthy()
        expect(fetchFn).not.toHaveBeenCalledWith('/__mavonengine/plugin-install', expect.objectContaining({ method: 'POST' }))

        fireEvent.click(screen.getByLabelText('I have checked the source and trust it'))
        fireEvent.click(screen.getByRole('button', { name: 'Install' }))

        await screen.findByRole('dialog', { name: 'Installing @acme/weather' })
        expect(fetchFn).toHaveBeenCalledWith('/__mavonengine/plugin-install', expect.objectContaining({ method: 'POST', body: JSON.stringify({ packages: ['@acme/weather'] }) }))
      })

      it('closes the dialog without installing on cancel', async () => {
        const fetchFn = servers({ install: canInstall })
        render(<PluginsPanel fetchFn={fetchFn} />)
        fireEvent.click(await screen.findByText('@acme/weather'))
        fireEvent.click(await screen.findByRole('button', { name: 'Install @acme/weather…' }))

        fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))

        expect(screen.queryByRole('dialog')).toBeNull()
        expect(fetchFn).not.toHaveBeenCalledWith('/__mavonengine/plugin-install', expect.objectContaining({ method: 'POST' }))
      })

      it('installs any other package through the same dialog', async () => {
        render(<PluginsPanel fetchFn={servers({ install: canInstall })} />)
        const input = await screen.findByLabelText('Another package')
        const submit = screen.getByRole('button', { name: 'Install…' }) as HTMLButtonElement
        expect(submit.disabled).toBe(true)

        fireEvent.change(input, { target: { value: 'some-plugin@1.2.0  file:../mine' } })
        fireEvent.click(submit)

        screen.getByRole('dialog', { name: 'Install some-plugin@1.2.0, file:../mine?' })
        screen.getByText('https://www.npmjs.com/package/some-plugin')
      })

      it('refuses what is no package before asking anything', async () => {
        render(<PluginsPanel fetchFn={servers({ install: canInstall })} />)

        fireEvent.change(await screen.findByLabelText('Another package'), { target: { value: 'forest; rm -rf ~' } })
        fireEvent.click(screen.getByRole('button', { name: 'Install…' }))

        expect(screen.getByRole('alert').textContent).toContain('not something that can be installed')
        expect(screen.queryByRole('dialog')).toBeNull()
      })

      it('only shows the command when the project doesn\'t run under mavonengine dev', async () => {
        render(<PluginsPanel fetchFn={servers({ install: { available: false, reason: 'Start the project with `mavonengine dev` to install packages from here', job: null } })} />)
        fireEvent.click(await screen.findByText('@acme/weather'))

        await screen.findByText(/Start the project with `mavonengine dev` to install packages from here\./)
        screen.getByText('npx @mavonengine/cli install @acme/weather')
        expect(screen.queryByRole('button', { name: 'Install @acme/weather…' })).toBeNull()
        expect(screen.queryByLabelText('Another package')).toBeNull()
      })
    })

    it('says so when nothing is left to install', async () => {
      render(<PluginsPanel fetchFn={servers({ available: [AVAILABLE[0]] })} />)

      await screen.findByText('The project has every plugin on the list.')
    })

    it('keeps showing the project\'s plugins when the list can\'t be read', async () => {
      render(<PluginsPanel fetchFn={servers({ available: null })} />)

      expect((await screen.findByRole('status')).textContent).toContain('was not found')
      screen.getByText('Plugins (3)')
      screen.getByRole('heading', { name: '@acme/forest' })
    })

    it('reads the list from the url in localStorage when there is one', async () => {
      localStorage.setItem('mavonengine:plugins-url', 'https://raw.githubusercontent.com/me/fork/dev/plugins.json')
      const fetchFn = servers()
      render(<PluginsPanel fetchFn={fetchFn} />)

      await screen.findByText('Available to install (2)')
      expect(fetchFn).toHaveBeenCalledWith('https://raw.githubusercontent.com/me/fork/dev/plugins.json', expect.anything())
    })
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
