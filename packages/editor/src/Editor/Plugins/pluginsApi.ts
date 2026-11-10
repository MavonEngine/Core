import type { PluginInfo, PluginInfoList } from '@mavonengine/core/Plugins/types'
import { PLUGINS_INFO_PATH } from '@mavonengine/core/Plugins/types'

export type { PluginInfo, PluginInfoList }

/**
 * The plugins in the project's mavonengine.json, as the dev server describes them: version, readme, prefabs.
 * Asked on the page's own origin, which the Vite dev server with `mavonEnginePlugins()` answers.
 */
export async function fetchPlugins(fetchFn: typeof fetch = fetch): Promise<PluginInfoList> {
  let res: Response
  try {
    res = await fetchFn(PLUGINS_INFO_PATH)
  }
  catch {
    throw new Error('The dev server is not reachable')
  }

  // Without the Vite plugin the dev server answers with the game's page or a 404
  if (res.status === 404 || !res.headers.get('content-type')?.includes('application/json'))
    throw new Error('The dev server doesn\'t list plugins. Add mavonEnginePlugins() from @mavonengine/core/Plugins/vite to the client\'s vite.config, or update @mavonengine/core')
  if (res.status === 403)
    throw new Error('The dev server only lists plugins to localhost')
  if (!res.ok)
    throw new Error(`The dev server answered ${res.status} ${res.statusText}`)

  const { root = null, plugins } = await res.json() as Partial<PluginInfoList>
  return { root, plugins: Array.isArray(plugins) ? plugins : [] }
}

export interface PluginPrefab {
  name: string
  /** Shown in the editor's asset list, when the plugin registered the prefab in this session */
  label?: string
  /** Registered by the plugin's client entry right now, so it can be placed */
  registered: boolean
  /** Listed under the plugin's `prefabs` in mavonengine.json: its assets ship in a release */
  used: boolean
}

/**
 * The prefabs of a plugin: the ones it registered in the running editor, plus the ones its manifest or
 * the project's mavonengine.json name
 */
export function pluginPrefabs(plugin: PluginInfo, registered: { name: string, label?: string, plugin?: string }[]): PluginPrefab[] {
  const prefabs = new Map<string, PluginPrefab>()

  for (const prefab of registered.filter(prefab => prefab.plugin === plugin.package))
    prefabs.set(prefab.name, { name: prefab.name, label: prefab.label, registered: true, used: false })

  for (const name of [...plugin.declaredPrefabs, ...plugin.usedPrefabs]) {
    if (!prefabs.has(name))
      prefabs.set(name, { name, registered: false, used: false })
  }

  for (const name of plugin.usedPrefabs)
    prefabs.get(name)!.used = true

  return [...prefabs.values()]
}
