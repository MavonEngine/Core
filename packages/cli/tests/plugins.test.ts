import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fetchPluginRegistry, normalizeRegistry, PLUGIN_REGISTRY_URL, PluginRegistryError } from '@mavonengine/core/Plugins/registry'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { UsageError } from '../src/commands/dashboard'
import { formatPlugins, parsePluginsArgs, projectPlugins, runPluginsCommand } from '../src/commands/plugins'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

const LIST = {
  version: 1,
  plugins: [
    { package: '@mavonengine/http-monitoring', name: 'HTTP Monitoring', description: 'The dashboard in the browser', target: 'server', engine: '>=0.0.22', homepage: 'https://example.com/monitoring' },
    { package: 'forest', target: 'both' },
  ],
}

function answer(status: number, body: unknown) {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status }))
}

let dir: string

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'mavonengine-plugins-cli-'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('plugins.json in the repository', () => {
  const registry = normalizeRegistry(JSON.parse(readFileSync(join(REPO_ROOT, 'plugins.json'), 'utf8')), 'plugins.json')

  it('is a list this CLI reads, with every entry kept', () => {
    const raw = JSON.parse(readFileSync(join(REPO_ROOT, 'plugins.json'), 'utf8'))

    expect(registry.version).toBe(1)
    expect(registry.plugins).toHaveLength(raw.plugins.length)
    expect(new Set(registry.plugins.map(plugin => plugin.package)).size).toBe(registry.plugins.length)
  })

  it('lists the http-monitoring plugin first, as its package describes itself', () => {
    const pkg = JSON.parse(readFileSync(join(REPO_ROOT, 'packages', 'plugins', 'http-monitoring', 'package.json'), 'utf8'))

    expect(registry.plugins[0]).toMatchObject({
      package: pkg.name,
      target: pkg.mavonengine.target,
      engine: pkg.mavonengine.engine,
    })
    expect(registry.plugins[0].description).toBeTruthy()
    // The readme on main, next to the package
    expect(registry.plugins[0].readme).toBe('https://raw.githubusercontent.com/MavonEngine/Core/main/packages/plugins/http-monitoring/README.md')
    expect(readFileSync(join(REPO_ROOT, 'packages', 'plugins', 'http-monitoring', 'README.md'), 'utf8')).toContain(pkg.name)
  })

  it('is read from the main branch on GitHub', () => {
    expect(PLUGIN_REGISTRY_URL).toBe('https://raw.githubusercontent.com/MavonEngine/Core/main/plugins.json')
  })
})

describe('plugin registry', () => {
  it('fetches the list without caching it', async () => {
    const fetch = answer(200, LIST)

    const registry = await fetchPluginRegistry({ fetch })

    expect(fetch).toHaveBeenCalledWith(PLUGIN_REGISTRY_URL, expect.objectContaining({ cache: 'no-store' }))
    expect(registry.url).toBe(PLUGIN_REGISTRY_URL)
    expect(registry.plugins).toEqual([
      { package: '@mavonengine/http-monitoring', name: 'HTTP Monitoring', description: 'The dashboard in the browser', target: 'server', engine: '>=0.0.22', homepage: 'https://example.com/monitoring', readme: undefined },
      { package: 'forest', name: 'forest', description: undefined, target: 'both', engine: undefined, homepage: undefined, readme: undefined },
    ])
  })

  it('leaves out entries without a package and ignores what it doesn\'t know', () => {
    const registry = normalizeRegistry({ version: 3, plugins: [{ name: 'Nameless' }, null, { package: 'ok', target: 'sideways', stars: 5 }] }, 'x')

    expect(registry.version).toBe(3)
    expect(registry.plugins).toEqual([{ package: 'ok', name: 'ok', description: undefined, target: undefined, engine: undefined, homepage: undefined, readme: undefined }])
  })

  it('says what is wrong when there is no list', async () => {
    await expect(fetchPluginRegistry({ fetch: vi.fn(async () => {
      throw new Error('getaddrinfo ENOTFOUND')
    }) })).rejects.toThrow(/Can't reach .*ENOTFOUND/)
    await expect(fetchPluginRegistry({ fetch: answer(404, 'Not Found') })).rejects.toThrow('was not found')
    await expect(fetchPluginRegistry({ fetch: answer(500, 'oops') })).rejects.toThrow('500')
    await expect(fetchPluginRegistry({ fetch: answer(200, '<html>') })).rejects.toThrow('not valid JSON')
    await expect(fetchPluginRegistry({ fetch: answer(200, { nothing: true }) })).rejects.toBeInstanceOf(PluginRegistryError)
  })
})

describe('mavonengine plugins', () => {
  it('reads the list from GitHub unless told otherwise', () => {
    expect(parsePluginsArgs([], dir, {})).toEqual({ cwd: dir, url: PLUGIN_REGISTRY_URL, json: false })
    expect(parsePluginsArgs([], dir, { MAVONENGINE_PLUGINS_URL: 'https://example.com/fork.json' })).toMatchObject({ url: 'https://example.com/fork.json' })
    expect(parsePluginsArgs(['--url', 'https://example.com/mine.json', '--json'], dir, { MAVONENGINE_PLUGINS_URL: 'https://example.com/fork.json' }))
      .toMatchObject({ url: 'https://example.com/mine.json', json: true })
    expect(parsePluginsArgs(['-h'])).toBe('help')
    expect(() => parsePluginsArgs(['forest'])).toThrow(UsageError)
  })

  it('prints the available plugins and how to install one', async () => {
    let output = ''
    const code = await runPluginsCommand({ cwd: dir, url: PLUGIN_REGISTRY_URL, json: false }, { fetch: answer(200, LIST), write: text => output += text })

    expect(code).toBe(0)
    expect(output).toBe([
      `2 plugins available, from ${PLUGIN_REGISTRY_URL}`,
      '',
      '  @mavonengine/http-monitoring  HTTP Monitoring',
      '    The dashboard in the browser',
      '    runs on server · @mavonengine/core >=0.0.22',
      '    https://example.com/monitoring',
      '',
      '  forest',
      '    runs on client + server',
      '',
      'Install one with: mavonengine install <package>',
      '',
    ].join('\n'))
  })

  it('says which plugins the project already has', async () => {
    writeFileSync(join(dir, 'mavonengine.json'), JSON.stringify({ plugins: { '@mavonengine/http-monitoring': {}, 'forest': { enabled: false } } }))
    mkdirSync(join(dir, 'client'))
    let output = ''

    // From inside a workspace of the project
    await runPluginsCommand({ cwd: join(dir, 'client'), url: PLUGIN_REGISTRY_URL, json: false }, { fetch: answer(200, LIST), write: text => output += text })

    expect(output).toContain('runs on server · @mavonengine/core >=0.0.22 · in this project\n')
    expect(output).toContain('runs on client + server · in this project, disabled\n')
  })

  it('prints the list as JSON when asked', async () => {
    let output = ''
    await runPluginsCommand({ cwd: dir, url: 'https://example.com/mine.json', json: true }, { fetch: answer(200, LIST), write: text => output += text })

    expect(JSON.parse(output)).toMatchObject({ url: 'https://example.com/mine.json', version: 1, plugins: [{ package: '@mavonengine/http-monitoring' }, { package: 'forest' }] })
  })

  it('copes with an empty list, a newer format and a broken mavonengine.json', () => {
    expect(formatPlugins({ url: 'x', version: 1, plugins: [] }, new Map())).toContain('The list is empty.')
    expect(formatPlugins({ url: 'x', version: 2, plugins: [] }, new Map())).toContain('update @mavonengine/cli')

    writeFileSync(join(dir, 'mavonengine.json'), '{ not json')
    expect(projectPlugins(dir).size).toBe(0)
  })
})
