import type { AvailablePlugin } from '@mavonengine/core/Plugins/registry'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type GameServerClient from './GameServerClient'
import { fetchPluginReadme, fetchPluginRegistry, PLUGIN_REGISTRY_URL } from '@mavonengine/core/Plugins/registry'
import { z } from 'zod'
import { READ_ONLY, run } from './result'

export { PLUGIN_REGISTRY_URL }

/**
 * Where the list of plugins that can be installed is read from, and how. The list is plugins.json on the main
 * branch of the MavonEngine repository unless `url` says otherwise.
 */
export interface PluginListSource {
  url: string
  /** Replaceable in tests */
  fetch?: typeof globalThis.fetch
}

interface InstalledPlugin {
  package: string
  [key: string]: unknown
}

interface Route {
  method: string
  path: string
  source?: string
  plugin?: string
  devOnly?: boolean
  summary?: string
}

const installCommand = (pkg: string) => `npx @mavonengine/cli install ${pkg}`

/**
 * The plugins of the project and their HTTP endpoints, from the game server
 */
async function installedPlugins(client: GameServerClient) {
  const [{ plugins = [] }, routes] = await Promise.all([
    client.plugins() as Promise<{ plugins?: InstalledPlugin[] }>,
    // An older server lists its plugins but not its routes: the plugins are still worth showing
    (client.routes() as Promise<{ routes?: Route[] }>).then(result => result.routes ?? [], () => null),
  ])

  return plugins.map(plugin => ({
    ...plugin,
    endpoints: routes
      ? routes
          .filter(route => route.source === 'plugin' && route.plugin === plugin.package)
          .map(({ method, path, devOnly, summary }) => ({ method, path, devOnly, summary }))
      : null,
  }))
}

/**
 * list_plugins for the plugins the project has, and, with `list`, available_plugins and plugin_readme for the
 * ones it could install: the plugins of the MavonEngine repository, as options to suggest.
 */
export function registerPluginTools(server: McpServer, client: GameServerClient, list?: PluginListSource) {
  server.registerTool('list_plugins', {
    title: 'Plugins of the project',
    description: 'The engine plugins in the project\'s mavonengine.json: version, whether each is enabled and runs on this server, '
      + 'where it runs (client, server or both), its prefabs and the HTTP endpoints it registered. '
      + 'A problem is reported for a plugin that is missing or invalid. See available_plugins for plugins the project could add.',
    annotations: READ_ONLY,
  }, () => run(async () => ({ plugins: await installedPlugins(client) })))

  if (!list)
    return

  const registry = () => fetchPluginRegistry({ url: list.url, fetch: list.fetch })

  server.registerTool('available_plugins', {
    title: 'Plugins that can be installed',
    description: 'The official MavonEngine plugins: what each does, where it runs, the engine versions it supports and the command '
      + 'that installs it. Says which ones the project already has. Check this before building something a plugin already does, '
      + 'such as chat or a monitoring dashboard, and read plugin_readme before suggesting one. '
      + 'Installing is for the user to do: this server is read-only.',
    annotations: { ...READ_ONLY, openWorldHint: true },
  }, () => run(async () => {
    const [{ url, plugins }, installed] = await Promise.all([
      registry(),
      // Whether the project has them is extra: the list is worth showing without a running server
      installedPlugins(client).then(found => new Map(found.map(plugin => [plugin.package, plugin])), () => null),
    ])

    return {
      source: url,
      projectPlugins: installed ? 'known' : 'unknown: the game server could not be asked',
      plugins: plugins.map((plugin: AvailablePlugin) => ({
        package: plugin.package,
        name: plugin.name,
        description: plugin.description,
        runsOn: plugin.target,
        engine: plugin.engine,
        homepage: plugin.homepage,
        hasReadme: !!plugin.readme,
        inProject: installed ? installed.has(plugin.package) : null,
        install: installCommand(plugin.package),
      })),
    }
  }))

  server.registerTool('plugin_readme', {
    title: 'Read a plugin\'s readme',
    description: 'The README of an official MavonEngine plugin as Markdown, by its package name from available_plugins: '
      + 'what it does, its options for mavonengine.json, how a game hooks into it and its limits.',
    inputSchema: { package: z.string().describe('npm package of the plugin, e.g. @mavonengine/chat') },
    annotations: { ...READ_ONLY, openWorldHint: true },
  }, async ({ package: pkg }) => {
    try {
      const { plugins } = await registry()
      const plugin = plugins.find(candidate => candidate.package === pkg)
      if (!plugin)
        throw new Error(`${pkg} is not on the list of plugins. It has: ${plugins.map(candidate => candidate.package).join(', ') || 'nothing'}`)

      return { content: [{ type: 'text', text: await fetchPluginReadme(plugin, { fetch: list.fetch }) }] }
    }
    catch (err) {
      return { isError: true, content: [{ type: 'text', text: (err as Error).message }] }
    }
  })
}
