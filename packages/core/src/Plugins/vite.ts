import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Plugin, ResolvedConfig, ViteDevServer } from 'vite'
import type { EnabledPlugin } from './ProjectConfig.js'
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, resolve } from 'node:path'
import { assetsDir, CONFIG_FILE, enabledPlugins, findConfigRoot, recordPrefabUsage, releaseAssets, resolveInside } from './ProjectConfig.js'
import { pluginAssetBase, PREFAB_USED_PATH } from './types.js'

export { PREFAB_USED_PATH }

export const VIRTUAL_PLUGINS_ID = 'virtual:mavonengine/plugins'
const RESOLVED_VIRTUAL_PLUGINS_ID = `\0${VIRTUAL_PLUGINS_ID}`

const MAX_BODY_BYTES = 4096
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
}

/**
 * Vite plugin for MavonEngine engine plugins:
 * - `virtual:mavonengine/plugins` exports the client entries of the plugins enabled in mavonengine.json
 * - in dev, serves plugin assets under `/plugins/<package>/` and records the prefabs the editor places
 * - on build, copies only the plugin assets the release needs into `plugins/<package>/`
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

  return {
    name: 'mavonengine-plugins',

    configResolved(resolved) {
      config = resolved
    },

    resolveId(id) {
      return id === VIRTUAL_PLUGINS_ID ? RESOLVED_VIRTUAL_PLUGINS_ID : undefined
    },

    load(id) {
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

    configureServer(server) {
      watchConfig(server)
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').split('?')[0]

        if (req.method === 'POST' && url === PREFAB_USED_PATH) {
          handlePrefabUsed(req, res)
          return
        }

        if ((req.method === 'GET' || req.method === 'HEAD') && url.startsWith('/plugins/') && servePluginAsset(url, req, res))
          return

        next()
      })
    },

    generateBundle() {
      if (config.command !== 'build' || config.build.ssr)
        return

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
