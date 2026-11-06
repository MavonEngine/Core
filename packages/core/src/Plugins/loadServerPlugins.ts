import type { LoadedPlugin, ServerPlugin } from './types'
import { pathToFileURL } from 'node:url'
import { enabledPlugins } from './ProjectConfig'

/**
 * Import the server entries of the plugins enabled in `<root>/mavonengine.json`.
 * Plugins that are missing, invalid or fail to import are skipped and reported in `warnings`.
 */
export async function loadServerPlugins(root: string): Promise<{ plugins: LoadedPlugin<ServerPlugin>[], warnings: string[] }> {
  const { plugins: enabled, warnings } = enabledPlugins(root, 'server')
  const plugins: LoadedPlugin<ServerPlugin>[] = []

  for (const plugin of enabled) {
    try {
      const module = await import(pathToFileURL(plugin.entry).href)
      const exported: ServerPlugin | undefined = module.default
      if (!exported || typeof exported !== 'object') {
        warnings.push(`${plugin.package}: server entry has no default export`)
        continue
      }
      plugins.push({ package: plugin.package, options: plugin.options, plugin: exported })
    }
    catch (err) {
      warnings.push(`${plugin.package}: could not load its server entry: ${(err as Error).message}`)
    }
  }

  return { plugins, warnings }
}
