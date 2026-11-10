import { mkdirSync, readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  addPluginToConfig,
  enabledPlugins,
  findConfigRoot,
  MAX_README_CHARS,
  PluginConfigError,
  pluginInfos,
  readConfig,
  readPluginManifest,
  recordPrefabUsage,
  releaseAssets,
  resolveInside,
  shippedAssetPaths,
} from '../../src/Plugins/ProjectConfig'
import { installPlugin, tempProject, writeConfig, writeFile } from './fixtures'

let root: string

beforeEach(() => {
  root = tempProject()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

const trees = {
  target: 'both' as const,
  client: './dist/client.js',
  server: './dist/server.js',
  assets: {
    shared: ['textures/bark.png'],
    prefabs: { Tree: ['models/tree.glb'], Rock: ['models/rock.glb'] },
  },
}

const treeFiles = {
  'dist/client.js': 'export default {}',
  'dist/server.js': 'export default {}',
  'assets/textures/bark.png': 'png',
  'assets/models/tree.glb': 'tree',
  'assets/models/rock.glb': 'rock',
}

describe('readConfig', () => {
  it('treats a missing file as an empty config', () => {
    expect(readConfig(root)).toEqual({ plugins: {} })
  })

  it('adds a missing plugins section', () => {
    writeConfig(root, '{ "name": "x" }')

    expect(readConfig(root)).toEqual({ name: 'x', plugins: {} })
  })

  it('throws on invalid JSON', () => {
    writeConfig(root, '{ nope')

    expect(() => readConfig(root)).toThrow(PluginConfigError)
  })

  it('throws when plugins is not an object', () => {
    writeConfig(root, '{ "plugins": [] }')

    expect(() => readConfig(root)).toThrow('"plugins"')
  })
})

describe('findConfigRoot', () => {
  it('walks up to the directory with mavonengine.json', () => {
    writeConfig(root, {})
    mkdirSync(join(root, 'client', 'src'), { recursive: true })

    expect(findConfigRoot(join(root, 'client', 'src'))).toBe(root)
  })
})

describe('addPluginToConfig', () => {
  it('creates mavonengine.json with the plugin', () => {
    expect(addPluginToConfig(root, 'trees')).toBe(true)

    expect(JSON.parse(readFileSync(join(root, 'mavonengine.json'), 'utf8'))).toEqual({ plugins: { trees: { enabled: true } } })
  })

  it('keeps other keys and the settings of an existing entry', () => {
    writeConfig(root, { custom: 1, plugins: { trees: { enabled: false, prefabs: ['Tree'] } } } as any)

    expect(addPluginToConfig(root, 'trees')).toBe(true)

    expect(readConfig(root)).toEqual({ custom: 1, plugins: { trees: { enabled: true, prefabs: ['Tree'] } } })
  })

  it('leaves an enabled plugin alone', () => {
    writeConfig(root, { plugins: { trees: { enabled: true } } })

    expect(addPluginToConfig(root, 'trees')).toBe(false)
  })

  it('writes 2-space JSON with a trailing newline', () => {
    addPluginToConfig(root, 'trees')

    expect(readFileSync(join(root, 'mavonengine.json'), 'utf8')).toBe('{\n  "plugins": {\n    "trees": {\n      "enabled": true\n    }\n  }\n}\n')
  })
})

describe('recordPrefabUsage', () => {
  it('adds the prefab once', () => {
    writeConfig(root, { plugins: { trees: {} } })

    expect(recordPrefabUsage(root, 'trees', 'Tree')).toBe(true)
    expect(recordPrefabUsage(root, 'trees', 'Tree')).toBe(false)

    expect(readConfig(root).plugins.trees.prefabs).toEqual(['Tree'])
  })

  it('ignores plugins that are not in the config', () => {
    writeConfig(root, { plugins: {} })

    expect(recordPrefabUsage(root, 'trees', 'Tree')).toBe(false)
  })
})

describe('readPluginManifest', () => {
  it('reads the manifest of an installed plugin', () => {
    const dir = installPlugin(root, 'trees', trees, treeFiles)

    expect(readPluginManifest(root, 'trees')).toEqual({ package: 'trees', version: '1.0.0', dir, manifest: trees })
  })

  it('finds scoped packages hoisted to a parent directory', () => {
    installPlugin(root, '@acme/trees', trees)
    mkdirSync(join(root, 'client'))

    expect(readPluginManifest(join(root, 'client'), '@acme/trees')?.package).toBe('@acme/trees')
  })

  it('is undefined for packages without a mavonengine field or not installed', () => {
    installPlugin(root, 'lodash', undefined)

    expect(readPluginManifest(root, 'lodash')).toBeUndefined()
    expect(readPluginManifest(root, 'missing')).toBeUndefined()
  })

  it('rejects an invalid target', () => {
    installPlugin(root, 'bad', { target: 'browser' } as any)

    expect(() => readPluginManifest(root, 'bad')).toThrow('mavonengine.target')
  })

  it('requires an entry for each side the plugin runs on', () => {
    installPlugin(root, 'bad', { target: 'both', client: './c.js' })

    expect(() => readPluginManifest(root, 'bad')).toThrow('"mavonengine.server" is required')
  })
})

describe('enabledPlugins', () => {
  it('lists the plugins for a side in config order with their options', () => {
    installPlugin(root, 'trees', trees, treeFiles)
    installPlugin(root, 'chat', { target: 'server', server: './server.js' }, { 'server.js': '' })
    installPlugin(root, 'hud', { target: 'client', client: './client.js' }, { 'client.js': '' })
    writeConfig(root, { plugins: { chat: {}, trees: { options: { density: 2 } }, hud: {} } })

    expect(enabledPlugins(root, 'server').plugins.map(p => p.package)).toEqual(['chat', 'trees'])
    const client = enabledPlugins(root, 'client').plugins
    expect(client.map(p => p.package)).toEqual(['trees', 'hud'])
    expect(client[0].options).toEqual({ density: 2 })
    expect(client[0].entry).toBe(join(root, 'node_modules', 'trees', 'dist', 'client.js'))
  })

  it('skips disabled plugins', () => {
    installPlugin(root, 'trees', trees, treeFiles)
    writeConfig(root, { plugins: { trees: { enabled: false } } })

    expect(enabledPlugins(root, 'client')).toEqual({ plugins: [], warnings: [] })
  })

  it('warns about plugins that are missing, invalid or unbuilt', () => {
    installPlugin(root, 'bad', { target: 'nope' } as any)
    installPlugin(root, 'unbuilt', { target: 'client', client: './dist/client.js' })
    writeConfig(root, { plugins: { missing: {}, bad: {}, unbuilt: {} } })

    const { plugins, warnings } = enabledPlugins(root, 'client')

    expect(plugins).toEqual([])
    expect(warnings).toHaveLength(3)
    expect(warnings[0]).toContain('missing is listed')
    expect(warnings[1]).toContain('mavonengine.target')
    expect(warnings[2]).toContain('is the plugin built?')
  })

  it('refuses entries outside the package', () => {
    installPlugin(root, 'sneaky', { target: 'client', client: '../other/client.js' })
    installPlugin(root, 'other', undefined, { 'client.js': '' })
    writeConfig(root, { plugins: { sneaky: {} } })

    expect(enabledPlugins(root, 'client').plugins).toEqual([])
  })
})

describe('release assets', () => {
  it('ships the shared assets and those of used prefabs only', () => {
    expect(shippedAssetPaths(trees, ['Tree'])).toEqual(['textures/bark.png', 'models/tree.glb'])
    expect(shippedAssetPaths(trees, [])).toEqual(['textures/bark.png'])
  })

  it('maps them into plugins/<package>/ in the release', () => {
    const dir = installPlugin(root, 'trees', trees, treeFiles)
    writeConfig(root, { plugins: { trees: { prefabs: ['Tree'] } } })

    expect(releaseAssets(root)).toEqual({
      assets: [
        { package: 'trees', from: join(dir, 'assets', 'textures', 'bark.png'), to: 'plugins/trees/textures/bark.png', path: 'textures/bark.png' },
        { package: 'trees', from: join(dir, 'assets', 'models', 'tree.glb'), to: 'plugins/trees/models/tree.glb', path: 'models/tree.glb' },
      ],
      warnings: [],
    })
  })

  it('uses the assets dir from the manifest', () => {
    installPlugin(root, 'trees', { ...trees, assets: { dir: './public', shared: ['a.png'] } }, { ...treeFiles, 'public/a.png': '' })
    writeConfig(root, { plugins: { trees: {} } })

    expect(releaseAssets(root).assets.map(a => a.from)).toEqual([join(root, 'node_modules', 'trees', 'public', 'a.png')])
  })

  it('warns about missing assets and paths outside the assets dir', () => {
    installPlugin(root, 'trees', { ...trees, assets: { shared: ['gone.png', '../package.json'] } }, treeFiles)
    writeConfig(root, { plugins: { trees: {} } })

    const { assets, warnings } = releaseAssets(root)

    expect(assets).toEqual([])
    expect(warnings).toEqual(['trees: asset gone.png not found', 'trees: asset ../package.json points outside its assets directory'])
  })
})

describe('resolveInside', () => {
  it('only resolves paths below the base', () => {
    const base = resolve('/a/b')

    expect(resolveInside(base, 'c/d')).toBe(join(base, 'c', 'd'))
    expect(resolveInside(base, '../c')).toBeUndefined()
    expect(resolveInside(base, resolve('/etc/passwd'))).toBeUndefined()
    expect(resolveInside(base, '')).toBeUndefined()
  })
})

describe('plugin infos', () => {
  const manifest = { target: 'server' as const, server: './server.js', engine: '^0.1.0', assets: { prefabs: { Tree: ['tree.glb'] } } }

  it('describes a plugin from its package.json, manifest and readme', () => {
    const dir = installPlugin(root, '@acme/chat', manifest, { 'Readme.md': '# Chat\n\nTalk to each other.' })
    writeFile(join(dir, 'package.json'), JSON.stringify({
      name: '@acme/chat',
      version: '2.3.1',
      description: 'In-game chat',
      license: 'MIT',
      repository: { url: 'https://example.com/chat.git' },
      mavonengine: manifest,
    }))
    writeConfig(root, { plugins: { '@acme/chat': { prefabs: ['Tree', 7 as any] } } })

    expect(pluginInfos(root)).toEqual([{
      package: '@acme/chat',
      enabled: true,
      installed: true,
      version: '2.3.1',
      description: 'In-game chat',
      license: 'MIT',
      homepage: 'https://example.com/chat.git',
      target: 'server',
      engine: '^0.1.0',
      readme: '# Chat\n\nTalk to each other.',
      declaredPrefabs: ['Tree'],
      usedPrefabs: ['Tree'],
    }])
  })

  it('lists plugins that are turned off, missing or invalid, and says what is wrong', () => {
    installPlugin(root, 'off', manifest)
    installPlugin(root, 'not-a-plugin', undefined)
    installPlugin(root, 'broken', { target: 'sideways' } as any)
    writeConfig(root, { plugins: { 'off': { enabled: false }, 'missing': {}, 'not-a-plugin': {}, 'broken': {} } })

    const infos = pluginInfos(root)

    expect(infos.map(info => [info.package, info.enabled, info.installed])).toEqual([
      ['off', false, true],
      ['missing', true, false],
      ['not-a-plugin', true, false],
      ['broken', true, false],
    ])
    expect(infos[0].problem).toBeUndefined()
    expect(infos[1].problem).toContain('not installed')
    expect(infos[2].problem).toContain('no "mavonengine" field')
    // Still says what the package is
    expect(infos[2].version).toBe('1.0.0')
    expect(infos[3].problem).toContain('target')
  })

  it('cuts off a very long readme', () => {
    installPlugin(root, 'wordy', manifest, { 'README.md': 'x'.repeat(MAX_README_CHARS + 50) })
    writeConfig(root, { plugins: { wordy: {} } })

    const [{ readme }] = pluginInfos(root)

    expect(readme!.length).toBeLessThan(MAX_README_CHARS + 50)
    expect(readme).toContain('cut off')
  })

  it('lists nothing for a project without plugins', () => {
    expect(pluginInfos(root)).toEqual([])
  })
})
