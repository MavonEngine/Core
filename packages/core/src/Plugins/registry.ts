/**
 * The list of plugins anyone can install, kept in plugins.json at the root of the MavonEngine repository.
 * It is read from the main branch on GitHub whenever it is asked for, so what is listed is what is on main right now.
 *
 * Runs in Node and in the browser: the CLI and the editor both read the list with it.
 */
export const PLUGIN_REGISTRY_URL = 'https://raw.githubusercontent.com/MavonEngine/Core/main/plugins.json'

/** Set to read the list from somewhere else: a fork, a branch, or a registry of your own */
export const PLUGIN_REGISTRY_ENV = 'MAVONENGINE_PLUGINS_URL'

/** The newest plugins.json format this CLI understands */
export const SUPPORTED_REGISTRY_VERSION = 1

export interface AvailablePlugin {
  /** npm package name, what `mavonengine install` takes */
  package: string
  /** Human readable name. Defaults to the package name */
  name: string
  description?: string
  /** Where it runs */
  target?: 'client' | 'server' | 'both'
  /** Supported @mavonengine/core versions, a semver range */
  engine?: string
  homepage?: string
  /** URL of its README as Markdown, e.g. the raw file on GitHub. Shown by the editor when the plugin is looked at */
  readme?: string
}

export interface PluginRegistry {
  /** Where the list was read from */
  url: string
  version: number
  plugins: AvailablePlugin[]
}

export class PluginRegistryError extends Error {}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

/**
 * Turn whatever plugins.json held into a list. Entries without a package name are left out, and unknown
 * fields are ignored, so an older CLI keeps working when the file gains fields.
 */
export function normalizeRegistry(raw: unknown, url: string): PluginRegistry {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || !Array.isArray((raw as { plugins?: unknown }).plugins))
    throw new PluginRegistryError(`${url} is not a plugin list: expected { "plugins": [...] }`)

  const { version, plugins } = raw as { version?: unknown, plugins: unknown[] }

  return {
    url,
    version: typeof version === 'number' ? version : 1,
    plugins: plugins.flatMap((entry) => {
      const plugin = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>
      const pkg = text(plugin.package)
      if (!pkg)
        return []

      const target = plugin.target === 'client' || plugin.target === 'server' || plugin.target === 'both' ? plugin.target : undefined
      return [{
        package: pkg,
        name: text(plugin.name) ?? pkg,
        description: text(plugin.description),
        target,
        engine: text(plugin.engine),
        homepage: text(plugin.homepage),
        readme: text(plugin.readme),
      }]
    }),
  }
}

/**
 * The plugins of the list a project doesn't have yet, given the packages in its mavonengine.json
 */
export function notInProject(plugins: AvailablePlugin[], inProject: Iterable<string>): AvailablePlugin[] {
  const have = new Set(inProject)
  return plugins.filter(plugin => !have.has(plugin.package))
}

const HTTP_URL_RE = /^https?:\/\//i

/** A README longer than this is cut off */
export const MAX_REMOTE_README_CHARS = 200_000

/**
 * Read the README a plugin of the list points to, as Markdown text. Throws PluginRegistryError when the
 * plugin names none or it can't be read.
 */
export async function fetchPluginReadme(plugin: Pick<AvailablePlugin, 'package' | 'readme'>, { timeoutMs = 10_000, fetch = globalThis.fetch }: Omit<FetchRegistryOptions, 'url'> = {}): Promise<string> {
  const url = plugin.readme
  if (!url || !HTTP_URL_RE.test(url))
    throw new PluginRegistryError(`The list has no readme for ${plugin.package}`)

  let res: Response
  try {
    res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
  }
  catch (err) {
    throw new PluginRegistryError(`Can't reach ${url}: ${(err as Error).message}`)
  }

  if (!res.ok)
    throw new PluginRegistryError(res.status === 404 ? `${url} was not found` : `${url} answered ${res.status} ${res.statusText}`)

  const markdown = await res.text()
  return markdown.length > MAX_REMOTE_README_CHARS ? `${markdown.slice(0, MAX_REMOTE_README_CHARS)}\n\n… (cut off)` : markdown
}

export interface FetchRegistryOptions {
  url?: string
  timeoutMs?: number
  fetch?: typeof globalThis.fetch
}

/**
 * Read the plugin list from GitHub (or `url`). Never cached, so it is what the branch holds right now.
 */
export async function fetchPluginRegistry({ url = PLUGIN_REGISTRY_URL, timeoutMs = 10_000, fetch = globalThis.fetch }: FetchRegistryOptions = {}): Promise<PluginRegistry> {
  let res: Response
  try {
    res = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(timeoutMs) })
  }
  catch (err) {
    throw new PluginRegistryError(`Can't reach ${url}: ${(err as Error).message}`)
  }

  if (res.status === 404)
    throw new PluginRegistryError(`${url} was not found`)
  if (!res.ok)
    throw new PluginRegistryError(`${url} answered ${res.status} ${res.statusText}`)

  let raw: unknown
  try {
    raw = JSON.parse(await res.text())
  }
  catch (err) {
    throw new PluginRegistryError(`${url} is not valid JSON: ${(err as Error).message}`)
  }

  return normalizeRegistry(raw, url)
}
