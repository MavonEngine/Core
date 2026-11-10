import type { AvailablePlugin } from '@mavonengine/core/Plugins/registry'
import process from 'node:process'
import { fetchPluginRegistry, PLUGIN_REGISTRY_ENV, PLUGIN_REGISTRY_URL } from '@mavonengine/core/Plugins/registry'

export interface AvailablePluginsState {
  /** `idle` until the list is first asked for */
  status: 'idle' | 'loading' | 'ready' | 'error'
  /** Where the list is read from */
  url: string
  plugins: AvailablePlugin[]
  error: string | null
}

/**
 * The plugins that are available to install, for the dashboard's Plugins tab. Read from plugins.json on GitHub
 * by the dashboard itself, not by the game server, and only once the tab is first shown.
 */
export default class AvailablePlugins {
  readonly state: AvailablePluginsState
  private listeners = new Set<() => void>()

  constructor(
    url = process.env[PLUGIN_REGISTRY_ENV] ?? PLUGIN_REGISTRY_URL,
    private fetchRegistry: (url: string) => Promise<{ plugins: AvailablePlugin[] }> = registryUrl => fetchPluginRegistry({ url: registryUrl }),
  ) {
    this.state = { status: 'idle', url, plugins: [], error: null }
  }

  onChange(listener: () => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Fetch the list if it wasn't yet. With `force` it is fetched again, keeping what is shown until the answer is in.
   */
  load(force = false): Promise<void> {
    const { state } = this
    if (state.status === 'loading' || (state.status !== 'idle' && !force))
      return Promise.resolve()

    state.status = 'loading'
    return this.fetchRegistry(state.url).then(({ plugins }) => {
      state.plugins = plugins
      state.error = null
      state.status = 'ready'
    }, (err: Error) => {
      state.error = err.message
      state.status = 'error'
    }).then(() => this.listeners.forEach(listener => listener()))
  }
}
