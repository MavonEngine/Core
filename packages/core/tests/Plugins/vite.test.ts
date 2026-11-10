import type { AddressInfo } from 'node:net'
import type { ViteDevServer } from 'vite'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { join } from 'node:path'
import { build, createServer } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readConfig } from '../../src/Plugins/ProjectConfig'
import { PLUGINS_INFO_PATH, PREFAB_USED_PATH, SCENE_SAVE_PATH } from '../../src/Plugins/types'
import { generatePluginsModule, mavonEnginePlugins } from '../../src/Plugins/vite'
import { installPlugin, tempProject, writeConfig, writeFile } from './fixtures'

let root: string

const forest = {
  target: 'both' as const,
  client: './client.js',
  server: './server.js',
  assets: { shared: ['bark.txt'], prefabs: { Tree: ['tree.txt'], Rock: ['rock.txt'] } },
}

beforeEach(() => {
  root = tempProject()
  installPlugin(root, 'forest', forest, {
    'client.js': 'export default { name: "Forest" }',
    'server.js': 'export default {}',
    'assets/bark.txt': 'bark',
    'assets/tree.txt': 'tree',
    'assets/rock.txt': 'rock',
  })
  writeConfig(root, { plugins: { forest: { prefabs: ['Tree'], options: { density: 2 } } } })
  writeFile(join(root, 'client', 'index.html'), '<script type="module" src="./main.js"></script>')
  writeFile(join(root, 'client', 'main.js'), 'import plugins from \'virtual:mavonengine/plugins\'\nwindow.plugins = plugins\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('generatePluginsModule', () => {
  it('imports each entry and exports the loaded plugins', () => {
    const code = generatePluginsModule([{ package: 'forest', entry: '/x/forest/client.js', options: { a: 1 } }])

    expect(code).toBe([
      'import plugin0 from "/x/forest/client.js"',
      '',
      'export default [',
      '  { package: "forest", options: {"a":1}, plugin: plugin0 },',
      ']',
      '',
    ].join('\n'))
  })

  it('adds the shipped assets in a release', () => {
    const code = generatePluginsModule([{ package: 'forest', entry: '/x/client.js', options: {} }], new Map([['forest', ['tree.txt']]]))

    expect(code).toContain('shippedAssets: ["tree.txt"]')
  })

  it('exports an empty list without plugins', () => {
    expect(generatePluginsModule([])).toBe('\nexport default [\n]\n')
  })
})

describe('build', () => {
  it('bundles the client entries and ships only the assets of used prefabs', async () => {
    const outDir = join(root, 'client', 'dist')
    await build({
      root: join(root, 'client'),
      logLevel: 'silent',
      configFile: false,
      plugins: [mavonEnginePlugins()],
      build: { outDir, minify: false },
    })

    expect(readFileSync(join(outDir, 'plugins', 'forest', 'bark.txt'), 'utf8')).toBe('bark')
    expect(readFileSync(join(outDir, 'plugins', 'forest', 'tree.txt'), 'utf8')).toBe('tree')
    expect(existsSync(join(outDir, 'plugins', 'forest', 'rock.txt'))).toBe(false)

    const js = readdirSync(join(outDir, 'assets')).filter(f => f.endsWith('.js')).map(f => readFileSync(join(outDir, 'assets', f), 'utf8')).join('\n')
    expect(js).toContain('Forest')
    expect(js).toContain('"tree.txt"')
    expect(js).toContain('density')
  })

  it('ships the scene files', async () => {
    writeFile(join(root, 'scenes', 'main.json'), '{"version":1,"name":"main","objects":[]}')
    const outDir = join(root, 'client', 'dist')
    await build({
      root: join(root, 'client'),
      logLevel: 'silent',
      configFile: false,
      plugins: [mavonEnginePlugins()],
      build: { outDir, minify: false },
    })

    expect(JSON.parse(readFileSync(join(outDir, 'scenes', 'main.json'), 'utf8')).name).toBe('main')
  })
})

describe('dev server', () => {
  let vite: ViteDevServer
  let base: string
  let http: ReturnType<typeof createHttpServer>

  beforeEach(async () => {
    vite = await createServer({
      root: join(root, 'client'),
      logLevel: 'silent',
      configFile: false,
      plugins: [mavonEnginePlugins()],
      server: { middlewareMode: true, hmr: false, watch: null },
      optimizeDeps: { noDiscovery: true },
    })
    http = createHttpServer(vite.middlewares)
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve))
    base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`
  })

  afterEach(async () => {
    await new Promise(resolve => http.close(resolve))
    await vite.close()
  })

  it('serves every plugin asset, used or not', async () => {
    const tree = await fetch(`${base}/plugins/forest/tree.txt`)
    const rock = await fetch(`${base}/plugins/forest/rock.txt`)

    expect(tree.status).toBe(200)
    expect(await tree.text()).toBe('tree')
    expect(await rock.text()).toBe('rock')
  })

  it('does not serve files outside the assets directory', async () => {
    const res = await fetch(`${base}/plugins/forest/%2e%2e/package.json`)

    expect(await res.text()).not.toContain('"mavonengine"')
  })

  it('lists the project\'s plugins with what their package says, read anew on every request', async () => {
    writeFile(join(root, 'node_modules', 'forest', 'README.md'), '# Forest\n\nTrees and rocks.')

    const res = await fetch(`${base}${PLUGINS_INFO_PATH}`)
    const { root: listedRoot, plugins } = await res.json() as { root: string, plugins: any[] }

    expect(res.status).toBe(200)
    expect(listedRoot).toBe(root)
    expect(plugins).toEqual([{
      package: 'forest',
      enabled: true,
      installed: true,
      version: '1.0.0',
      target: 'both',
      readme: '# Forest\n\nTrees and rocks.',
      declaredPrefabs: ['Tree', 'Rock'],
      usedPrefabs: ['Tree'],
    }])

    // A plugin added to mavonengine.json shows up without restarting the dev server
    writeConfig(root, { plugins: { forest: {}, missing: { enabled: false } } })
    const again = await (await fetch(`${base}${PLUGINS_INFO_PATH}`)).json() as { plugins: any[] }
    expect(again.plugins.map(plugin => [plugin.package, plugin.enabled, plugin.installed])).toEqual([['forest', true, true], ['missing', false, false]])
  })

  it('records the prefabs the editor places in mavonengine.json', async () => {
    const post = (body: unknown) => fetch(`${base}${PREFAB_USED_PATH}`, { method: 'POST', body: JSON.stringify(body) })

    const first = await post({ plugin: 'forest', prefab: 'Rock' })
    const again = await post({ plugin: 'forest', prefab: 'Rock' })

    expect(await first.json()).toEqual({ recorded: true })
    expect(await again.json()).toEqual({ recorded: false })
    expect(readConfig(root).plugins.forest.prefabs).toEqual(['Tree', 'Rock'])
    // The rest of the entry is kept
    expect(readConfig(root).plugins.forest.options).toEqual({ density: 2 })
  })

  it('rejects malformed prefab-used requests', async () => {
    const res = await fetch(`${base}${PREFAB_USED_PATH}`, { method: 'POST', body: '{"plugin": 1}' })

    expect(res.status).toBe(400)
  })

  describe('scenes', () => {
    const scene = {
      version: 1,
      name: 'main',
      settings: {},
      objects: [{ id: 'box_1', type: 'Primitive:Box', transform: { position: [1, 2, 3], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
    }
    const save = (body: unknown) => fetch(`${base}${SCENE_SAVE_PATH}`, { method: 'POST', body: JSON.stringify(body) })

    it('saves a scene to scenes/<name>.json in the project root and serves it back', async () => {
      const res = await save({ name: 'main', scene })

      expect(res.status).toBe(200)
      expect(JSON.parse(readFileSync(join(root, 'scenes', 'main.json'), 'utf8'))).toEqual(scene)
      expect(existsSync(join(root, 'scenes', 'main.json.tmp'))).toBe(false)

      const served = await fetch(`${base}/scenes/main.json`)
      expect(served.headers.get('cache-control')).toBe('no-store')
      expect(await served.json()).toEqual(scene)
    })

    it('rejects names that could leave the scenes directory', async () => {
      for (const name of ['../evil', 'a/b', '', 'x.json']) {
        const res = await save({ name, scene })
        expect(res.status).toBe(400)
      }
      expect(existsSync(join(root, 'evil.json'))).toBe(false)
    })

    it('rejects invalid scenes and keeps the file as it was', async () => {
      await save({ name: 'main', scene })
      const res = await save({ name: 'main', scene: { objects: [{ type: 'Primitive:Box' }] } })

      expect(res.status).toBe(400)
      expect((await res.json()).error).toContain('needs an "id"')
      expect(JSON.parse(readFileSync(join(root, 'scenes', 'main.json'), 'utf8'))).toEqual(scene)
    })

    it('leaves requests for scenes that do not exist to vite', async () => {
      const res = await fetch(`${base}/scenes/missing.json`)
      expect(res.headers.get('cache-control')).not.toBe('no-store')
    })
  })

  it('serves the virtual module without shipped assets in dev', async () => {
    const result = await vite.transformRequest('virtual:mavonengine/plugins')

    expect(result?.code).toContain('"forest"')
    expect(result?.code).not.toContain('shippedAssets')
  })
})
