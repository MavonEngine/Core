import type { AddressInfo } from 'node:net'
import type { ViteDevServer } from 'vite'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { createServer as createHttpServer } from 'node:http'
import { join } from 'node:path'
import { build, createServer } from 'vite'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DevPluginHost, pluginDataDir } from '../../src/Plugins/DevPluginHost'
import { enabledPlugins, readConfig } from '../../src/Plugins/ProjectConfig'
import { DEV_TOOLS_PATH, devPluginBase, pluginToolName } from '../../src/Plugins/types'
import { mavonEnginePlugins } from '../../src/Plugins/vite'
import { installPlugin, tempProject, writeConfig, writeFile } from './fixtures'

declare global {
  // eslint-disable-next-line vars-on-top
  var devPluginEvents: string[]
}

let root: string

/** A dev entry that answers with what it was given, and records when it starts and stops */
function echoEntry(name: string) {
  return `
export default {
  setup(ctx) { globalThis.devPluginEvents.push('setup ${name}') },
  destroy(ctx) { globalThis.devPluginEvents.push('destroy ${name}') },
  middleware(ctx) {
    return async (req, res, next) => {
      if (req.url.startsWith('/missing'))
        return next()
      if (req.url.startsWith('/throw'))
        throw new Error('it broke')
      if (req.url.startsWith('/options') && req.method === 'POST') {
        const written = ctx.updateOptions(options => { options.count = (options.count ?? 0) + 1 })
        res.setHeader('Content-Type', 'application/json')
        return res.end(JSON.stringify({ written, options: ctx.options }))
      }
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({
        name: '${name}',
        url: req.url,
        method: req.method,
        package: ctx.package,
        base: ctx.base,
        options: ctx.options,
        projectRoot: ctx.projectRoot,
        clientRoot: ctx.clientRoot,
        publicDir: ctx.publicDir,
        dataDir: ctx.dataDir,
      }))
    }
  },
}
`
}

beforeEach(() => {
  globalThis.devPluginEvents = []
  root = tempProject()
  installPlugin(root, 'forest', { target: 'client', client: './client.js', dev: './dev.js' }, {
    'client.js': 'export default {}',
    'dev.js': echoEntry('forest'),
  })
  installPlugin(root, '@kit/assets', { target: 'client', client: './client.js', dev: './dev.js' }, {
    'client.js': 'export default {}',
    'dev.js': echoEntry('assets'),
  })
  installPlugin(root, '@kit/assets-extra', { target: 'server', server: './server.js', dev: './dev.js' }, {
    'server.js': 'export default {}',
    'dev.js': echoEntry('assets-extra'),
  })
  installPlugin(root, 'plain', { target: 'client', client: './client.js' }, { 'client.js': 'export default {}' })
  writeConfig(root, {
    plugins: {
      'forest': {
        options: { density: 2 },
      },
      '@kit/assets': {},
      '@kit/assets-extra': {},
      'plain': {},
    },
  })
  writeFile(join(root, 'client', 'index.html'), '<script type="module" src="./main.js"></script>')
  writeFile(join(root, 'client', 'main.js'), 'import plugins from \'virtual:mavonengine/plugins\'\nwindow.plugins = plugins\n')
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('enabledPlugins for dev', () => {
  it('lists the plugins with a dev entry, whatever their target', () => {
    expect(enabledPlugins(root, 'dev').plugins.map(plugin => [plugin.package, plugin.entry])).toEqual([
      [
        'forest',
        join(root, 'node_modules', 'forest', 'dev.js'),
      ],
      [
        '@kit/assets',
        join(root, 'node_modules', '@kit', 'assets', 'dev.js'),
      ],
      [
        '@kit/assets-extra',
        join(root, 'node_modules', '@kit', 'assets-extra', 'dev.js'),
      ],
    ])
  })

  it('reports a dev entry that is missing or not a file name', () => {
    installPlugin(root, 'unbuilt', { target: 'client', client: './client.js', dev: './dist/dev.js' }, { 'client.js': '' })
    installPlugin(root, 'wrong', { target: 'client', client: './client.js', dev: 42 as unknown as string }, { 'client.js': '' })
    installPlugin(root, 'flag', { target: 'client', client: './client.js', reloadOnOptions: 'no' as unknown as boolean }, { 'client.js': '' })
    writeConfig(root, {
      plugins: { unbuilt: {}, wrong: {}, flag: {} },
    })

    expect(enabledPlugins(root, 'dev').warnings).toEqual([
      'unbuilt: dev entry ./dist/dev.js not found, is the plugin built?',
      'wrong: "mavonengine.dev" must be a file of the package',
      'flag: "mavonengine.reloadOnOptions" must be true or false',
    ])
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
      plugins: [
        mavonEnginePlugins(),
      ],
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

  it('starts every dev entry and gives it the project\'s directories', async () => {
    expect(globalThis.devPluginEvents).toEqual(['setup forest', 'setup assets', 'setup assets-extra'])

    const res = await fetch(`${base}${devPluginBase('forest')}catalog?page=2`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({
      name: 'forest',
      url: '/catalog?page=2',
      method: 'GET',
      package: 'forest',
      base: '/__mavonengine/plugins/forest/',
      options: { density: 2 },
      projectRoot: root,
      clientRoot: join(root, 'client'),
      publicDir: join(root, 'client', 'public'),
      dataDir: join(root, '.mavonengine', 'plugins', 'forest'),
    })
  })

  it('routes scoped packages to the one whose name matches whole', async () => {
    const assets = await (await fetch(`${base}${devPluginBase('@kit/assets')}x`)).json() as { name: string, url: string, dataDir: string }
    const extra = await (await fetch(`${base}${devPluginBase('@kit/assets-extra')}x`)).json() as { name: string }
    const bare = await (await fetch(`${base}/__mavonengine/plugins/@kit/assets`)).json() as { name: string, url: string }

    expect(assets.name).toBe('assets')
    expect(assets.url).toBe('/x')
    expect(assets.dataDir).toBe(join(root, '.mavonengine', 'plugins', '@kit', 'assets'))
    expect(extra.name).toBe('assets-extra')
    expect(bare).toMatchObject({ name: 'assets', url: '/' })
  })

  it('answers 404 for plugins without a dev entry and for what the middleware passes on', async () => {
    const plain = await fetch(`${base}${devPluginBase('plain')}x`)
    const missing = await fetch(`${base}${devPluginBase('forest')}missing`)

    expect(plain.status).toBe(404)
    expect(plain.headers.get('content-type')).toContain('application/json')
    expect(missing.status).toBe(404)
    expect((await missing.json() as { error: string }).error).toBe('forest has nothing at /missing')
  })

  it('answers 500 when the middleware throws', async () => {
    const res = await fetch(`${base}${devPluginBase('forest')}throw`)

    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'it broke' })
  })

  it('lets the dev entry change its options, and reads them anew', async () => {
    const first = await (await fetch(`${base}${devPluginBase('forest')}options`, { method: 'POST' })).json()
    const second = await (await fetch(`${base}${devPluginBase('forest')}options`, { method: 'POST' })).json()

    expect(first).toEqual({
      written: true,
      options: { density: 2, count: 1 },
    })
    expect(second).toEqual({
      written: true,
      options: { density: 2, count: 2 },
    })
    expect(readConfig(root).plugins.forest.options).toEqual({ density: 2, count: 2 })
  })

  it('refuses changes another site asks for from the browser', async () => {
    const crossSite = await fetch(`${base}${devPluginBase('forest')}options`, {
      method: 'POST',
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    })
    const otherOrigin = await fetch(`${base}${devPluginBase('forest')}options`, {
      method: 'POST',
      headers: { Origin: 'https://evil.example' },
    })
    const read = await fetch(`${base}${devPluginBase('forest')}catalog`, {
      headers: { 'Sec-Fetch-Site': 'cross-site' },
    })

    expect(crossSite.status).toBe(403)
    expect(otherOrigin.status).toBe(403)
    expect(readConfig(root).plugins.forest.options).toEqual({ density: 2 })
    // Reading is fine: the browser keeps the answer from the other site
    expect(read.status).toBe(200)
  })

  it('reloads the game when options change, unless the plugin turned that off', async () => {
    installPlugin(root, 'quiet', { target: 'client', client: './client.js', reloadOnOptions: false }, { 'client.js': 'export default {}' })
    const plugins = {
      'forest': {
        options: { density: 2 },
      },
      '@kit/assets': {},
      '@kit/assets-extra': {},
      'plain': {},
      'quiet': {
        options: { n: 1 },
      },
    }
    writeConfig(root, { plugins })
    await vite.transformRequest('virtual:mavonengine/plugins')

    const send = vi.spyOn(vite.ws, 'send')
    const changed = (config: object) => {
      writeConfig(root, config)
      vite.watcher.emit('change', join(root, 'mavonengine.json'))
    }

    changed({
      plugins: {
        ...plugins,
        quiet: {
          options: { n: 2 },
        },
      },
    })
    expect(send).not.toHaveBeenCalled()
    // The game gets the new options the next time it loads
    expect((await vite.transformRequest('virtual:mavonengine/plugins'))?.code).toContain('"n":2')

    changed({
      plugins: {
        ...plugins,
        forest: {
          options: { density: 5 },
        },
      },
    })
    expect(send).toHaveBeenCalledWith({ type: 'full-reload' })
    // Vite doesn't reload on its own either: mavonengine.json isn't a dependency of the module
    expect(vite.moduleGraph.getModulesByFile(join(root, 'mavonengine.json'))?.size ?? 0).toBe(0)
  })

  it('stops the dev entries when the dev server closes', async () => {
    await vite.close()

    expect(globalThis.devPluginEvents.slice(3)).toEqual(['destroy assets-extra', 'destroy assets', 'destroy forest'])
  })
})

describe('devPluginHost', () => {
  const logged: string[] = []
  const host = () => new DevPluginHost({
    projectRoot: root,
    clientRoot: join(root, 'client'),
    publicDir: join(root, 'client', 'public'),
    logger: {
      info: m => logged.push(m),
      warn: m => logged.push(m),
      error: m => logged.push(m),
    },
  })

  beforeEach(() => {
    logged.length = 0
  })

  it('restarts the dev entries when the plugins change, not when only their options do', async () => {
    const devHost = host()
    await devHost.sync()
    expect(devHost.packages).toEqual(['forest', '@kit/assets', '@kit/assets-extra'])

    writeConfig(root, {
      plugins: {
        'forest': {
          options: { density: 3 },
        },
        '@kit/assets': {},
        '@kit/assets-extra': {},
        'plain': {},
      },
    })
    await devHost.sync()
    expect(globalThis.devPluginEvents).toEqual(['setup forest', 'setup assets', 'setup assets-extra'])

    writeConfig(root, {
      plugins: {
        'forest': {},
        '@kit/assets-extra': { enabled: false },
      },
    })
    await devHost.sync()
    expect(devHost.packages).toEqual(['forest'])
    expect(globalThis.devPluginEvents.slice(3)).toEqual([
      'destroy assets-extra',
      'destroy assets',
      'destroy forest',
      'setup forest',
    ])

    await devHost.close()
    expect(devHost.packages).toEqual([])
  })

  it('keeps the other plugins running when one fails to load or start, and says why on its URL', async () => {
    installPlugin(root, 'broken', { target: 'client', client: './client.js', dev: './dev.js' }, {
      'client.js': '',
      'dev.js': 'export default { setup() { throw new Error("no network") } }',
    })
    installPlugin(root, 'empty', { target: 'client', client: './client.js', dev: './dev.js' }, { 'client.js': '', 'dev.js': 'export const x = 1' })
    writeConfig(root, {
      plugins: { broken: {}, empty: {}, forest: {} },
    })

    const devHost = host()
    await devHost.sync()

    expect(devHost.packages).toEqual(['forest'])
    expect(logged).toEqual([
      'broken: its dev entry failed to start: no network',
      'empty: could not load its dev entry: it has no default export',
    ])

    const res = {
      statusCode: 0,
      headersSent: false,
      headers: {} as Record<string, string>,
      body: '',
      setHeader(k: string, v: string) {
        this.headers[k] = v
      },
      end(body: string) {
        this.body = body
      },
    }
    const req = {
      url: `${devPluginBase('broken')}x`,
      method: 'GET',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    }
    expect(devHost.handle(req as any, res as any)).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 10))
    expect(res.statusCode).toBe(404)
    expect(JSON.parse(res.body).error).toBe('Its dev entry is not running: its dev entry failed to start: no network')

    await devHost.close()
  })

  it('leaves other URLs to the next middleware', () => {
    const req = {
      url: '/__mavonengine/plugins',
      method: 'GET',
      headers: {},
      socket: { remoteAddress: '127.0.0.1' },
    }
    expect(host().handle(req as any, {} as any)).toBe(false)
  })

  it('keeps a plugin\'s files under .mavonengine/plugins', () => {
    expect(pluginDataDir('/p', '@kit/assets')).toBe(join('/p', '.mavonengine', 'plugins', '@kit', 'assets'))
  })
})

describe('build', () => {
  it('never loads a dev entry', async () => {
    const outDir = join(root, 'client', 'dist')
    await build({
      root: join(root, 'client'),
      logLevel: 'silent',
      configFile: false,
      plugins: [
        mavonEnginePlugins(),
      ],
      build: { outDir, minify: false },
    })

    expect(globalThis.devPluginEvents).toEqual([])
    expect(existsSync(join(outDir, 'index.html'))).toBe(true)
    expect(readFileSync(join(outDir, 'index.html'), 'utf8')).not.toContain('dev.js')
  })
})

describe('mcp tools of dev entries', () => {
  let vite: ViteDevServer
  let base: string
  let http: ReturnType<typeof createHttpServer>

  const toolsEntry = `
export default {
  mcpTools(ctx) {
    return [
      {
        name: 'count',
        title: 'Count',
        description: 'Adds to a counter in the options',
        input: { type: 'object', properties: { by: { type: 'number' } }, required: ['by'] },
        run(args) {
          ctx.updateOptions(options => { options.count = (options.count ?? 0) + args.by })
          return { count: ctx.options.count }
        },
      },
      { name: 'peek', description: 'Reads the options', readOnly: true, run: () => ctx.options },
      { name: 'wipe', description: 'Breaks', destructive: true, openWorld: true, run() { throw new Error('nothing to wipe') } },
      { name: 'Bad Name', description: 'x', run() {} },
      { name: 'no_run', description: 'x' },
      { name: 'odd_input', description: 'x', input: { type: 'string' }, run() {} },
    ]
  },
}
`

  beforeEach(async () => {
    installPlugin(root, '@kit/tools', { target: 'client', client: './client.js', dev: './dev.js' }, { 'client.js': 'export default {}', 'dev.js': toolsEntry })
    writeConfig(root, {
      plugins: {
        '@kit/tools': {
          options: { count: 1 },
        },
        'forest': {},
      },
    })
    vite = await createServer({
      root: join(root, 'client'),
      logLevel: 'silent',
      configFile: false,
      plugins: [
        mavonEnginePlugins(),
      ],
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

  const runTool = (name: string, args: unknown, headers: Record<string, string> = {}) => fetch(`${base}${DEV_TOOLS_PATH}/${name}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ arguments: args }),
  })

  it('lists the tools under the plugin\'s name, leaving out the ones described wrong', async () => {
    const { tools } = await (await fetch(`${base}${DEV_TOOLS_PATH}`)).json() as { tools: any[] }

    expect(tools).toEqual([
      {
        name: 'tools_count',
        plugin: '@kit/tools',
        title: 'Count',
        description: 'Adds to a counter in the options',
        input: {
          type: 'object',
          properties: {
            by: { type: 'number' },
          },
          required: ['by'],
        },
        readOnly: false,
        destructive: false,
        openWorld: false,
      },
      {
        name: 'tools_peek',
        plugin: '@kit/tools',
        description: 'Reads the options',
        input: { type: 'object', properties: {} },
        readOnly: true,
        destructive: false,
        openWorld: false,
      },
      {
        name: 'tools_wipe',
        plugin: '@kit/tools',
        description: 'Breaks',
        input: { type: 'object', properties: {} },
        readOnly: false,
        destructive: true,
        openWorld: true,
      },
    ])
  })

  it('runs a tool and answers with what it returned', async () => {
    const res = await runTool('tools_count', { by: 2 })

    expect(await res.json()).toEqual({
      result: { count: 3 },
    })
    expect(readConfig(root).plugins['@kit/tools'].options).toEqual({ count: 3 })
    expect(await (await runTool('tools_peek', {})).json()).toEqual({
      result: { count: 3 },
    })
  })

  it('reports what a tool threw as its error', async () => {
    expect(await (await runTool('tools_wipe', {})).json()).toEqual({ error: 'nothing to wipe' })
  })

  it('names the tools there are when asked for one that isn\'t', async () => {
    const res = await runTool('tools_nope', {})

    expect(res.status).toBe(404)
    expect((await res.json() as { error: string }).error).toBe('No tool tools_nope: the plugins\' dev entries offer tools_count, tools_peek, tools_wipe')
  })

  it('refuses calls from another site, and bodies that aren\'t JSON objects', async () => {
    expect((await runTool('tools_count', { by: 1 }, { 'Sec-Fetch-Site': 'cross-site' })).status).toBe(403)
    expect((await fetch(`${base}${DEV_TOOLS_PATH}/tools_count`, { method: 'POST', body: '{"arguments":{}}' })).status).toBe(403)
    expect((await runTool('tools_count', [1])).status).toBe(400)
    expect(readConfig(root).plugins['@kit/tools'].options).toEqual({ count: 1 })
  })
})

describe('pluginToolName', () => {
  it('is the package without its scope, then the tool', () => {
    expect(pluginToolName('@mavonengine/kenney', 'import')).toBe('kenney_import')
    expect(pluginToolName('my.plugin', 'run')).toBe('my_plugin_run')
  })
})
