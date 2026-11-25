import type { IncomingMessage, ServerResponse } from 'node:http'
import type { EnabledPlugin } from './ProjectConfig.js'
import type { DevMiddleware, DevPlugin, DevPluginContext, PluginOptions } from './types.js'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { fromLocalhost, fromThisPage } from './devRequest.js'
import { enabledPlugins, readConfig, updateConfig } from './ProjectConfig.js'
import { DEV_PLUGINS_PATH, devPluginBase } from './types.js'

export interface DevPluginHostOptions {
  projectRoot: string
  clientRoot: string
  publicDir: string
  logger: { info(message: string): void, warn(message: string): void, error(message: string): void }
  /** Imports a dev entry. Default: Node's `import()`, fresh when the file changed */
  importEntry?(entry: string): Promise<{ default?: unknown }>
}

interface Running {
  package: string
  entry: string
  plugin: DevPlugin
  ctx: DevPluginContext
  middleware?: DevMiddleware
}

/** Where a plugin keeps files that are not part of the game: `<root>/.mavonengine/plugins/<package>` */
export function pluginDataDir(projectRoot: string, pkg: string): string {
  return join(projectRoot, '.mavonengine', 'plugins', ...pkg.split('/'))
}

function defaultImport(entry: string): Promise<{ default?: unknown }> {
  let version = ''
  try {
    version = `?v=${statSync(entry).mtimeMs}`
  }
  catch {}
  return import(/* @vite-ignore */ `${pathToFileURL(entry).href}${version}`)
}

/**
 * Runs the dev entries of the project's plugins in the client's Vite dev server and routes requests under
 * `/__mavonengine/plugins/<package>/` to them.
 */
export class DevPluginHost {
  private running: Running[] = []
  /** Why a plugin with a dev entry isn't running, by package */
  private failed = new Map<string, string>()
  private signature: string | undefined
  /** The load or unload in progress: requests wait for it */
  private pending: Promise<void> = Promise.resolve()

  constructor(private readonly options: DevPluginHostOptions) {}

  /** The packages whose dev entry runs */
  get packages(): string[] {
    return this.running.map(plugin => plugin.package)
  }

  /**
   * Start the dev entries of the enabled plugins, or restart them when the plugins or their entries changed since the
   * last call. A change of options alone keeps them running: their `ctx.options` reads the current ones.
   */
  sync(): Promise<void> {
    this.pending = this.pending.then(() => this.load())
    return this.pending
  }

  /** Stop every dev entry */
  close(): Promise<void> {
    this.pending = this.pending.then(async () => {
      await this.unload()
      this.signature = undefined
    })
    return this.pending
  }

  private async load() {
    let plugins: EnabledPlugin[]
    try {
      const result = enabledPlugins(this.options.projectRoot, 'dev')
      plugins = result.plugins
      result.warnings.forEach(warning => this.options.logger.warn(`Plugin skipped: ${warning}`))
    }
    catch (err) {
      this.options.logger.warn(`Dev entries not loaded: ${(err as Error).message}`)
      return
    }

    const signature = JSON.stringify(plugins.map(plugin => [plugin.package, plugin.entry]))
    if (signature === this.signature)
      return

    await this.unload()
    this.signature = signature

    for (const enabled of plugins) {
      let plugin: DevPlugin
      try {
        const module = await (this.options.importEntry ?? defaultImport)(enabled.entry)
        if (!module.default || typeof module.default !== 'object')
          throw new Error('it has no default export')
        plugin = module.default as DevPlugin
      }
      catch (err) {
        this.fail(enabled.package, `could not load its dev entry: ${(err as Error).message}`)
        continue
      }

      const ctx = this.context(enabled.package, plugin)
      try {
        await plugin.setup?.(ctx)
        const middleware = plugin.middleware?.(ctx)
        this.running.push({ package: enabled.package, entry: enabled.entry, plugin, ctx, middleware })
      }
      catch (err) {
        this.fail(enabled.package, `its dev entry failed to start: ${(err as Error).message}`)
      }
    }
  }

  private fail(pkg: string, reason: string) {
    this.failed.set(pkg, reason)
    this.options.logger.warn(`${pkg}: ${reason}`)
  }

  private async unload() {
    const running = this.running
    this.running = []
    this.failed.clear()
    for (const { package: pkg, plugin, ctx } of running.reverse()) {
      try {
        await plugin.destroy?.(ctx)
      }
      catch (err) {
        this.options.logger.warn(`${pkg}: its dev entry failed to stop: ${(err as Error).message}`)
      }
    }
  }

  private context(pkg: string, plugin: DevPlugin): DevPluginContext {
    const { projectRoot, clientRoot, publicDir, logger } = this.options
    const prefix = `${plugin.name ?? pkg}: `

    return {
      package: pkg,
      get options(): PluginOptions {
        try {
          return readConfig(projectRoot).plugins[pkg]?.options ?? {}
        }
        catch {
          return {}
        }
      },
      projectRoot,
      clientRoot,
      publicDir,
      dataDir: pluginDataDir(projectRoot, pkg),
      base: devPluginBase(pkg),
      logger: {
        info: message => logger.info(prefix + message),
        warn: message => logger.warn(prefix + message),
        error: message => logger.error(prefix + message),
      },
      updateOptions(change) {
        return updateConfig(projectRoot, (config) => {
          const entry = config.plugins[pkg]
          if (!entry)
            return false

          const current = entry.options ?? {}
          const next = structuredClone(current)
          if (change(next) === false || JSON.stringify(next) === JSON.stringify(current))
            return false

          entry.options = next
          return true
        })
      },
    }
  }

  /**
   * Answer a request under `/__mavonengine/plugins/`. Returns false for any other URL, which is left to the next
   * middleware.
   */
  handle(req: IncomingMessage, res: ServerResponse): boolean {
    const url = req.url ?? ''
    if (!url.startsWith(`${DEV_PLUGINS_PATH}/`))
      return false

    void this.dispatch(req, res, url)
    return true
  }

  private async dispatch(req: IncomingMessage, res: ServerResponse, url: string) {
    const reply = (status: number, error: string) => {
      if (res.headersSent) {
        res.end()
        return
      }
      res.statusCode = status
      res.setHeader('Content-Type', 'application/json')
      res.setHeader('Cache-Control', 'no-store')
      res.end(JSON.stringify({ error }))
    }

    if (!fromLocalhost(req)) {
      reply(403, 'Only available from localhost')
      return
    }
    if (req.method !== 'GET' && req.method !== 'HEAD' && !fromThisPage(req)) {
      reply(403, 'Only the page this dev server serves may change things')
      return
    }

    await this.pending

    let path: string
    try {
      path = decodeURIComponent(url.split('?')[0])
    }
    catch {
      reply(400, 'Malformed URL')
      return
    }

    // The longest base first, so `@a/b` doesn't answer for `@a/b-c`
    const match = [...this.running]
      .sort((a, b) => b.ctx.base.length - a.ctx.base.length)
      .find(plugin => path.startsWith(plugin.ctx.base) || path === plugin.ctx.base.slice(0, -1))

    if (!match) {
      const pkg = path.slice(DEV_PLUGINS_PATH.length + 1)
      const reason = [...this.failed].find(([failed]) => pkg === failed || pkg.startsWith(`${failed}/`))?.[1]
      reply(404, reason ? `Its dev entry is not running: ${reason}` : 'No plugin with a dev entry answers here')
      return
    }

    if (!match.middleware) {
      reply(404, `${match.package} handles no requests`)
      return
    }

    // The rest as it was sent, with its query, unless the base itself was encoded
    const query = url.includes('?') ? url.slice(url.indexOf('?')) : ''
    req.url = url.startsWith(match.ctx.base)
      ? url.slice(match.ctx.base.length - 1)
      : `${encodeURI(path.slice(match.ctx.base.length - 1) || '/')}${query}`

    try {
      await match.middleware(req, res, (err) => {
        if (err)
          reply(500, (err as Error).message ?? String(err))
        else
          reply(404, `${match.package} has nothing at ${req.url}`)
      })
    }
    catch (err) {
      match.ctx.logger.error(`request ${req.method} ${req.url} failed: ${(err as Error).stack ?? err}`)
      reply(500, (err as Error).message)
    }
  }
}
