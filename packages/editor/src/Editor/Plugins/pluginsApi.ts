import type { InstallJob, InstallStatus } from '@mavonengine/core/Plugins/install'
import type { AvailablePlugin } from '@mavonengine/core/Plugins/registry'
import type { PluginInfo, PluginInfoList } from '@mavonengine/core/Plugins/types'
import { PLUGIN_INSTALL_PATH } from '@mavonengine/core/Plugins/install'
import { fetchPluginReadme, fetchPluginRegistry, notInProject, PLUGIN_REGISTRY_URL } from '@mavonengine/core/Plugins/registry'
import { PLUGINS_INFO_PATH } from '@mavonengine/core/Plugins/types'

export type { AvailablePlugin, InstallJob, InstallStatus, PluginInfo, PluginInfoList }

/** Put a URL here in localStorage to read the list of available plugins from a fork or a branch */
export const PLUGINS_URL_KEY = 'mavonengine:plugins-url'

export function registryUrl(): string {
  try {
    return localStorage.getItem(PLUGINS_URL_KEY) || PLUGIN_REGISTRY_URL
  }
  catch {
    return PLUGIN_REGISTRY_URL
  }
}

/**
 * The plugins that can be installed and the project doesn't have yet: plugins.json on the main branch of the
 * MavonEngine repository, read from GitHub by the browser.
 */
export async function fetchAvailablePlugins(installed: PluginInfo[], fetchFn: typeof fetch = fetch): Promise<AvailablePlugin[]> {
  const { plugins } = await fetchPluginRegistry({ url: registryUrl(), fetch: fetchFn })
  return notInProject(plugins, installed.map(plugin => plugin.package))
}

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

/**
 * The README of a plugin that isn't installed, read from the URL the list gives for it
 */
export function fetchAvailableReadme(plugin: AvailablePlugin, fetchFn: typeof fetch = fetch): Promise<string> {
  return fetchPluginReadme(plugin, { fetch: fetchFn })
}

const NO_INSTALL = 'The dev server can\'t install packages. Update @mavonengine/core, and start the project with `mavonengine dev`'

/**
 * Whether packages can be installed from the editor, and how the running or last install goes.
 * Never throws: a dev server that can't be asked can't install either.
 */
export async function fetchInstallStatus(fetchFn: typeof fetch = fetch): Promise<InstallStatus> {
  try {
    const res = await fetchFn(PLUGIN_INSTALL_PATH)
    if (!res.ok || !res.headers.get('content-type')?.includes('application/json'))
      return { available: false, reason: NO_INSTALL, job: null }

    const { available, reason, job = null } = await res.json() as Partial<InstallStatus>
    return { available: available === true, reason, job }
  }
  catch {
    return { available: false, reason: 'The dev server is not reachable', job: null }
  }
}

/**
 * Ask the dev server to install `packages`. It hands that to `mavonengine dev`, which installs them, adds the
 * plugins among them to mavonengine.json and restarts the dev servers. Resolves once the install has started.
 */
export async function startInstall(packages: string[], fetchFn: typeof fetch = fetch): Promise<InstallJob> {
  let res: Response
  try {
    res = await fetchFn(PLUGIN_INSTALL_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ packages }),
    })
  }
  catch {
    throw new Error('The dev server is not reachable')
  }

  if (!res.headers.get('content-type')?.includes('application/json'))
    throw new Error(NO_INSTALL)

  const { job, error } = await res.json() as { job?: InstallJob, error?: string }
  if (!res.ok || !job)
    throw new Error(error ?? `The dev server answered ${res.status} ${res.statusText}`)

  return job
}
