import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import type { EnabledPlugin } from './ProjectConfig.js'
import { createReadStream, existsSync, readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import process from 'node:process'
import { sceneFilePath, writeSceneFile } from '../Scene/loadSceneFile.js'
import { SCENE_NAME_RE, SCENES_DIR } from '../Scene/types.js'
import { DevBridgeHub, handleBridgeRequest } from './devBridge.js'
import { DEV_CONTROL_TOKEN_ENV, DEV_CONTROL_TOKEN_HEADER, DEV_CONTROL_URL_ENV, invalidPackages, PLUGIN_INSTALL_PATH } from './install.js'
import { assetsDir, CONFIG_FILE, enabledPlugins, findConfigRoot, pluginInfos, recordPrefabUsage, releaseAssets, resolveInside } from './ProjectConfig.js'
import { pluginAssetBase, PLUGINS_INFO_PATH, PREFAB_USED_PATH, SCENE_SAVE_PATH } from './types.js'

export { PLUGIN_INSTALL_PATH, PLUGINS_INFO_PATH, PREFAB_USED_PATH, SCENE_SAVE_PATH }

export const VIRTUAL_PLUGINS_ID = 'virtual:mavonengine/plugins'
const RESOLVED_VIRTUAL_PLUGINS_ID = `\0${VIRTUAL_PLUGINS_ID}`

/** Injected into every page Vite serves in dev, starts the dev bridge. Never part of a build */
export const VIRTUAL_DEV_BRIDGE_ID = 'virtual:mavonengine/dev-bridge'
const RESOLVED_VIRTUAL_DEV_BRIDGE_ID = `\0${VIRTUAL_DEV_BRIDGE_ID}`

/**
 * `import.meta.hot` only exists in modules Vite transforms, so this module hands it to the bridge in core,
 * which may be pre-bundled. Imported like the game imports core, so both use the same copy.
 */
const DEV_BRIDGE_ENTRY = '@mavonengine/core/Dev/DevBridge'
const DEV_BRIDGE_MODULE = `import { startDevBridge } from '${DEV_BRIDGE_ENTRY}'

if (import.meta.hot)
  startDevBridge(import.meta.hot)
`

const MAX_BODY_BYTES = 4096
const MAX_SCENE_BYTES = 20 * 1024 * 1024
const SCENE_URL_RE = new RegExp(`^/${SCENES_DIR}/([\\w-]+)\\.json$`)
const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

const CONTENT_TYPES: Record<string, string> = {
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ktx2': 'image/ktx2',
  '.hdr': 'application/octet-stream',
  '.svg': 'image/svg+xml',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.ttf': 'font/ttf',
  '.woff2': 'font/woff2',
  '.typeface.json': 'application/json',
}

export interface MavonEnginePluginsOptions {
  /** Directory with mavonengine.json. Default: the nearest one from the Vite root upwards */
  root?: string

  /**
   * In dev, let tools (`mavonengine mcp`) inspect the open game tabs through GET /__mavonengine/clients.
   * Only localhost, or with `MAVONENGINE_METRICS_TOKEN` as bearer token when that is set. Default true
   */
  devBridge?: boolean
}

/**
 * Vite plugin for MavonEngine engine plugins:
 * - `virtual:mavonengine/plugins` exports the client entries of the plugins enabled in mavonengine.json
 * - in dev, serves plugin assets under `/plugins/<package>/` and records the prefabs the editor places
 * - in dev, lists the project's plugins with their version and readme for the editor's Plugins view
 * - in dev, under `mavonengine dev`, lets the editor install packages: the request is handed to that process
 * - on build, copies only the plugin assets the release needs into `plugins/<package>/`
 * - in dev, the dev bridge: tools can inspect the open game tabs (renderer, world, logs, screenshots)
 */
export function mavonEnginePlugins(options: MavonEnginePluginsOptions = {}): Plugin {
  let config: ResolvedConfig
  /** What the virtual module was last generated from, to reload only when that changes */
  let loadedSignature: string | undefined

  const projectRoot = () => options.root ?? findConfigRoot(config.root)

  const clientPlugins = (root: string) => {
    const result = enabledPlugins(root, 'client')
    return { ...result, signature: JSON.stringify(result.plugins.map(p => [p.package, p.entry, p.options])) }
  }

  const warn = (message: string) => config.logger.warn(`[mavonengine] ${message}`)

  const devBridge = options.devBridge ?? true
  let bridge: DevBridgeHub | undefined

  return {
    name: 'mavonengine-plugins',

    configResolved(resolved) {
      config = resolved
    },

    resolveId(id) {
      if (id === VIRTUAL_PLUGINS_ID)
        return RESOLVED_VIRTUAL_PLUGINS_ID
      if (id === VIRTUAL_DEV_BRIDGE_ID && devBridge && config.command === 'serve')
        return RESOLVED_VIRTUAL_DEV_BRIDGE_ID
      return undefined
    },

    async load(id) {
      if (id === RESOLVED_VIRTUAL_DEV_BRIDGE_ID) {
        // Without core where the game imports it from there is no game to inspect
        if (!await this.resolve(DEV_BRIDGE_ENTRY, join(config.root, 'index.html'))) {
          warn(`Dev bridge off: ${DEV_BRIDGE_ENTRY} can't be resolved from ${config.root}`)
          return 'export {}\n'
        }
        return DEV_BRIDGE_MODULE
      }

      if (id !== RESOLVED_VIRTUAL_PLUGINS_ID)
        return undefined

      const root = projectRoot()
      if (!root) {
        loadedSignature = JSON.stringify([])
        return 'export default []\n'
      }

      this.addWatchFile(join(root, CONFIG_FILE))

      const { plugins, warnings, signature } = clientPlugins(root)
      loadedSignature = signature
      warnings.forEach(warning => warn(`Plugin skipped: ${warning}`))

      // In a release, tell the game which plugin assets exist so it doesn't request the ones left out
      const shipped = config.command === 'build' ? shippedAssetsByPackage(root) : undefined

      return generatePluginsModule(plugins, shipped)
    },

    transformIndexHtml() {
      if (!devBridge || config.command !== 'serve')
        return undefined

      // First in <head> so it also catches errors thrown while the game starts
      return [{
        tag: 'script',
        attrs: { type: 'module', src: `${config.base}@id/__x00__${VIRTUAL_DEV_BRIDGE_ID}` },
        injectTo: 'head-prepend',
      }]
    },

    configureServer(server) {
      watchConfig(server)
      if (devBridge)
        bridge = new DevBridgeHub(server.ws)

      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]

        if (bridge && handleBridgeRequest(bridge, req, res))
          return

        // Lets the dev bridge's `trace` sample JS stacks with the JS Self-Profiling API (Chromium). Only matters on pages
        if (bridge)
          res.setHeader('Document-Policy', 'js-profiling')

        if (req.method === 'POST' && url === PREFAB_USED_PATH) {
          handlePrefabUsed(req, res)
          return
        }

        if ((req.method === 'GET' || req.method === 'POST') && url === PLUGIN_INSTALL_PATH) {
          void handlePluginInstall(req, res)
          return
        }

        if (req.method === 'GET' && url === PLUGINS_INFO_PATH) {
          handlePluginsInfo(req, res)
          return
        }

        if (req.method === 'POST' && url === SCENE_SAVE_PATH) {
          handleSceneSave(req, res)
          return
        }

        if ((req.method === 'GET' || req.method === 'HEAD') && SCENE_URL_RE.test(url) && serveScene(url, req, res))
          return

        if ((req.method === 'GET' || req.method === 'HEAD') && url.startsWith('/plugins/') && servePluginAsset(url, req, res))
          return

        next()
      })
    },

    generateBundle() {
      if (config.command !== 'build' || config.build.ssr)
        return

      const scenes = scenesDir()
      if (existsSync(scenes)) {
        const files = readdirSync(scenes).filter(file => file.endsWith('.json') && SCENE_NAME_RE.test(file.slice(0, -'.json'.length)))
        for (const file of files)
          this.emitFile({ type: 'asset', fileName: `${SCENES_DIR}/${file}`, source: readFileSync(join(scenes, file)) })
        if (files.length)
          config.logger.info(`[mavonengine] Shipping ${files.length} scene${files.length === 1 ? '' : 's'}`)
      }

      const root = projectRoot()
      if (!root)
        return

      const { assets, warnings } = releaseAssets(root)
      warnings.forEach(warning => this.warn(warning))

      for (const asset of assets)
        this.emitFile({ type: 'asset', fileName: asset.to, source: readFileSync(asset.from) })

      if (assets.length)
        config.logger.info(`[mavonengine] Shipping ${assets.length} plugin asset${assets.length === 1 ? '' : 's'}`)
    },
  }

  /**
   * Reload the page when the plugin set or options change. Changes to `prefabs`, which the editor
   * writes while you work, don't reload since they only matter for the release.
   */
  function watchConfig(server: ViteDevServer) {
    const candidates = new Set<string>()
    const root = projectRoot()
    if (root) {
      candidates.add(join(root, CONFIG_FILE))
    }
    else {
      // Not created yet: `mavonengine install` puts it in the project root, usually here or one level up
      candidates.add(join(config.root, CONFIG_FILE))
      candidates.add(join(dirname(config.root), CONFIG_FILE))
    }

    server.watcher.add([...candidates])

    const onChange = (file: string) => {
      if (!candidates.has(resolve(file)))
        return

      const current = projectRoot()
      let signature = JSON.stringify([])
      try {
        if (current)
          signature = clientPlugins(current).signature
      }
      catch (err) {
        warn((err as Error).message)
        return
      }

      if (loadedSignature === undefined || signature === loadedSignature)
        return

      config.logger.info(`[mavonengine] ${CONFIG_FILE} plugins changed, reloading`)
      const module = server.moduleGraph.getModuleById(RESOLVED_VIRTUAL_PLUGINS_ID)
      if (module)
        server.moduleGraph.invalidateModule(module)
      server.ws.send({ type: 'full-reload' })
    }

    server.watcher.on('change', onChange)
    server.watcher.on('add', onChange)
    server.watcher.on('unlink', onChange)
  }

  function servePluginAsset(url: string, req: IncomingMessage, res: ServerResponse): boolean {
    const root = projectRoot()
    if (!root)
      return false

    let path: string
    try {
      path = decodeURIComponent(url)
    }
    catch {
      return false
    }

    let plugins: EnabledPlugin[]
    try {
      plugins = enabledPlugins(root, 'client').plugins
    }
    catch {
      return false
    }

    for (const plugin of plugins) {
      const base = pluginAssetBase(plugin.package)
      if (!path.startsWith(base))
        continue

      const file = resolveInside(assetsDir(plugin), path.slice(base.length))
      if (!file || !existsSync(file) || !statSync(file).isFile())
        return false

      res.statusCode = 200
      res.setHeader('Content-Type', contentType(file))
      res.setHeader('Content-Length', statSync(file).size)
      res.setHeader('Cache-Control', 'no-cache')
      if (req.method === 'HEAD')
        res.end()
      else
        createReadStream(file).pipe(res)
      return true
    }

    return false
  }

  /** `<project root>/scenes`, the Vite root when there is no mavonengine.json */
  function scenesDir() {
    return join(projectRoot() ?? config.root, SCENES_DIR)
  }

  /** Scenes are read from disk on every request so the game always gets what the editor saved last */
  function serveScene(url: string, req: IncomingMessage, res: ServerResponse): boolean {
    const name = SCENE_URL_RE.exec(url)![1]
    const file = sceneFilePath(dirname(scenesDir()), name)
    if (!existsSync(file))
      return false

    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Content-Length', statSync(file).size)
    res.setHeader('Cache-Control', 'no-store')
    if (req.method === 'HEAD')
      res.end()
    else
      createReadStream(file).pipe(res)
    return true
  }

  function handleSceneSave(req: IncomingMessage, res: ServerResponse) {
    const reply = (status: number, body: object) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify(body))
    }

    if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) {
      reply(403, { error: 'Only available from localhost' })
      return
    }

    readBody(req, MAX_SCENE_BYTES).then((body) => {
      let name: unknown
      let scene: unknown
      try {
        ({ name, scene } = JSON.parse(body))
      }
      catch {
        reply(400, { error: 'Expected a JSON body' })
        return
      }

      if (typeof name !== 'string' || !SCENE_NAME_RE.test(name)) {
        reply(400, { error: 'Expected { name, scene } with a name of letters, digits, - and _' })
        return
      }

      try {
        const file = sceneFilePath(dirname(scenesDir()), name)
        const written = writeSceneFile(file, scene)
        config.logger.info(`[mavonengine] Saved scene ${name} (${written.objects.length} objects) to ${file}`)
        reply(200, { saved: true, file, scene: written })
      }
      catch (err) {
        reply(400, { error: (err as Error).message })
      }
    }, (err: Error) => reply(413, { error: err.message }))
  }

  /**
   * GET: whether packages can be installed from the editor, and the running or last install.
   * POST { packages }: start installing them. The work is done by the `mavonengine dev` process that started this
   * dev server, which also restarts it afterwards, so the answer only says that the install started.
   *
   * Installing a package runs its code, so this takes requests from localhost and from this page only:
   * another site open in the browser can't use it.
   */
  async function handlePluginInstall(req: IncomingMessage, res: ServerResponse) {
    const reply = (status: number, body: object) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(body))
    }

    if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) {
      reply(403, { error: 'Only available from localhost' })
      return
    }

    const controlUrl = process.env[DEV_CONTROL_URL_ENV]
    const headers = { [DEV_CONTROL_TOKEN_HEADER]: process.env[DEV_CONTROL_TOKEN_ENV] ?? '' }
    const unavailable = 'Start the project with `mavonengine dev` to install packages from here'

    if (req.method === 'GET') {
      if (!controlUrl) {
        reply(200, { available: false, reason: unavailable, job: null })
        return
      }

      try {
        const status = await fetch(`${controlUrl}/status`, { headers })
        if (!status.ok)
          throw new Error(`it answered ${status.status}`)
        reply(200, { available: true, ...await status.json() as object })
      }
      catch (err) {
        reply(200, { available: false, reason: `mavonengine dev can't be reached: ${(err as Error).message}`, job: null })
      }
      return
    }

    if (!fromThisPage(req)) {
      reply(403, { error: 'Only the page this dev server serves may install packages' })
      return
    }
    // A JSON body can't be sent across origins without the browser asking first
    if (!req.headers['content-type']?.includes('application/json')) {
      reply(415, { error: 'Expected a JSON body' })
      return
    }

    let packages: unknown
    try {
      ({ packages } = JSON.parse(await readBody(req, MAX_BODY_BYTES)))
    }
    catch {
      reply(400, { error: 'Expected a JSON body' })
      return
    }

    const invalid = invalidPackages(packages)
    if (invalid) {
      reply(400, { error: invalid })
      return
    }

    if (!controlUrl) {
      reply(409, { error: unavailable })
      return
    }

    try {
      const started = await fetch(`${controlUrl}/install`, {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ packages }),
      })
      reply(started.status, await started.json() as object)
    }
    catch (err) {
      reply(502, { error: `mavonengine dev can't be reached: ${(err as Error).message}` })
    }
  }

  /** Read from disk on every request, so a plugin that was just installed or updated shows without a restart */
  function handlePluginsInfo(req: IncomingMessage, res: ServerResponse) {
    const reply = (status: number, body: object) => {
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify(body))
    }

    if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) {
      reply(403, { error: 'Only available from localhost' })
      return
    }

    const root = projectRoot()
    if (!root) {
      reply(200, { root: null, plugins: [] })
      return
    }

    try {
      reply(200, { root, plugins: pluginInfos(root) })
    }
    catch (err) {
      reply(500, { error: (err as Error).message })
    }
  }

  function handlePrefabUsed(req: IncomingMessage, res: ServerResponse) {
    const reply = (status: number, body?: object) => {
      res.statusCode = status
      if (body) {
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify(body))
      }
      else {
        res.end()
      }
    }

    if (!LOOPBACK_ADDRESSES.has(req.socket.remoteAddress ?? '')) {
      reply(403, { error: 'Only available from localhost' })
      return
    }

    const root = projectRoot()
    if (!root) {
      reply(404, { error: `No ${CONFIG_FILE} found` })
      return
    }

    let body = ''
    let tooLarge = false
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > MAX_BODY_BYTES) {
        tooLarge = true
        req.destroy()
      }
    })
    req.on('end', () => {
      if (tooLarge)
        return

      let plugin: unknown
      let prefab: unknown
      try {
        ({ plugin, prefab } = JSON.parse(body))
      }
      catch {
        reply(400, { error: 'Expected a JSON body' })
        return
      }

      if (typeof plugin !== 'string' || typeof prefab !== 'string' || !plugin || !prefab) {
        reply(400, { error: 'Expected { plugin: string, prefab: string }' })
        return
      }

      try {
        const recorded = recordPrefabUsage(root, plugin, prefab)
        if (recorded)
          config.logger.info(`[mavonengine] ${plugin}: prefab ${prefab} is now used, its assets will ship in the release`)
        reply(200, { recorded })
      }
      catch (err) {
        reply(500, { error: (err as Error).message })
      }
    })
  }
}

/**
 * Whether a request comes from a page of this dev server, or from no page at all (a tool on this machine).
 * A request another site makes from the browser says so in these headers.
 */
function fromThisPage(req: IncomingMessage): boolean {
  const site = req.headers['sec-fetch-site']
  if (typeof site === 'string')
    return site === 'same-origin'

  const { origin } = req.headers
  if (typeof origin !== 'string')
    return true

  try {
    return new URL(origin).host === req.headers.host
  }
  catch {
    return false
  }
}

function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = ''
    req.setEncoding('utf8')
    req.on('data', (chunk: string) => {
      body += chunk
      if (body.length > maxBytes) {
        reject(new Error(`Body is larger than ${maxBytes} bytes`))
        req.destroy()
      }
    })
    req.on('end', () => resolve(body))
    req.on('error', reject)
  })
}

function shippedAssetsByPackage(root: string): Map<string, string[]> {
  const shipped = new Map<string, string[]>()
  for (const asset of releaseAssets(root).assets) {
    if (!shipped.has(asset.package))
      shipped.set(asset.package, [])
    shipped.get(asset.package)!.push(asset.path)
  }
  return shipped
}

/**
 * Source of `virtual:mavonengine/plugins`.
 */
export function generatePluginsModule(plugins: Pick<EnabledPlugin, 'package' | 'entry' | 'options'>[], shipped?: Map<string, string[]>): string {
  const imports = plugins.map((plugin, i) => `import plugin${i} from ${JSON.stringify(plugin.entry.split('\\').join('/'))}`)

  const entries = plugins.map((plugin, i) => {
    const fields = [
      `package: ${JSON.stringify(plugin.package)}`,
      `options: ${JSON.stringify(plugin.options)}`,
      `plugin: plugin${i}`,
    ]
    if (shipped)
      fields.push(`shippedAssets: ${JSON.stringify(shipped.get(plugin.package) ?? [])}`)
    return `  { ${fields.join(', ')} },`
  })

  return [...imports, '', 'export default [', ...entries, ']', ''].join('\n')
}

function contentType(file: string): string {
  const lower = file.toLowerCase()
  if (lower.endsWith('.typeface.json'))
    return CONTENT_TYPES['.typeface.json']
  return CONTENT_TYPES[extname(lower)] ?? 'application/octet-stream'
}
