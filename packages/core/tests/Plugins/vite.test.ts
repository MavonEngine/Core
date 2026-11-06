import type { AddressInfo } from 'node:net'
import type { ViteDevServer } from 'vite'
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { join } from 'node:path'
import { build, createServer } from 'vite'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { readConfig } from '../../src/Plugins/ProjectConfig'
import { PREFAB_USED_PATH } from '../../src/Plugins/types'
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

  it('serves the virtual module without shipped assets in dev', async () => {
    const result = await vite.transformRequest('virtual:mavonengine/plugins')

    expect(result?.code).toContain('"forest"')
    expect(result?.code).not.toContain('shippedAssets')
  })
})
