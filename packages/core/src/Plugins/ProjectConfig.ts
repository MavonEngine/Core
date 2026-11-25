import type { PluginInfo, PluginOptions, PluginTarget } from './types'
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { engineCompat } from './compat.js'

/**
 * Node only: reads and writes mavonengine.json and the plugin manifests in node_modules.
 * Shared by the CLI, the Vite plugin and the game server.
 */

export const CONFIG_FILE = 'mavonengine.json'

export interface PluginConfigEntry {
  /** Default true */
  enabled?: boolean
  /** Prefabs of the plugin the project uses. Only their assets are shipped in a release */
  prefabs?: string[]
  /** Passed to the plugin as `ctx.options` */
  options?: PluginOptions
  [key: string]: unknown
}

export interface MavonEngineConfig {
  plugins: Record<string, PluginConfigEntry>
  /** Package of the database plugin to use, when more than one is enabled */
  database?: string
  /** Package of the auth plugin to use, when more than one is enabled */
  auth?: string
  /** Package of the notifications plugin to use, when more than one is enabled */
  notifications?: string
  /**
   * Where the game is, e.g. `https://mygame.com`: what links in mails and the like point to. Plugins get it as
   * `ctx.appUrl`. `MAVONENGINE_APP_URL` overrides it
   */
  appUrl?: string
  /** The game's name, e.g. in mails and their layout. Plugins get it as `ctx.appName` */
  appName?: string
  /** The `mavonengine upgrade` migrations the project has had, by id */
  migrations?: string[]
  [key: string]: unknown
}

/** The `mavonengine` field of a plugin's package.json */
export interface PluginManifest {
  target: PluginTarget
  /** Client entry, relative to the package. Required for client and both */
  client?: string
  /** Server entry, relative to the package. Required for server and both */
  server?: string
  /** Supported @mavonengine/core versions, a semver range */
  engine?: string
  assets?: {
    /** Directory the asset paths are relative to, relative to the package. Default `assets` */
    dir?: string
    /** Always shipped */
    shared?: string[]
    /** Shipped only when the prefab is listed in the project's mavonengine.json */
    prefabs?: Record<string, string[]>
  }
  /**
   * Directory of files a project may change, relative to the package, e.g. a mail layout. `mavonengine asset:publish
   * <package>` copies them into the project's `resources/<package>/`, and `ctx.publishedFile()` finds the copy
   */
  publish?: string
  /**
   * Dev entry, relative to the package: runs in the client's Vite dev server, never in a build. Any target can have
   * one. See `DevPlugin`
   */
  dev?: string
  /**
   * Whether the game reloads when the plugin's `options` in mavonengine.json change. Default true. Turn it off for a
   * plugin whose dev entry writes its options while the editor is open and whose client picks the change up itself
   */
  reloadOnOptions?: boolean
}

/** A side of the project a plugin entry is loaded on: the dev side is the client's Vite dev server */
export type PluginSide = 'client' | 'server' | 'dev'

export interface InstalledPlugin {
  package: string
  version?: string
  /** Absolute package directory */
  dir: string
  manifest: PluginManifest
}

export interface EnabledPlugin extends InstalledPlugin {
  options: PluginOptions
  prefabs: string[]
  /** Absolute path of the entry for the requested side */
  entry: string
}

export interface ReleaseAsset {
  package: string
  /** Absolute source file */
  from: string
  /** Path inside the client's output directory, e.g. `plugins/<package>/models/tree.glb` */
  to: string
  /** Relative to the plugin's assets directory */
  path: string
}

const TARGETS: PluginTarget[] = ['client', 'server', 'both']

export class PluginConfigError extends Error {}

/** Overrides `appUrl` in mavonengine.json, e.g. per deployment */
export const APP_URL_ENV = 'MAVONENGINE_APP_URL'

const TRAILING_SLASHES_RE = /\/+$/

/** An http(s) URL without its trailing slash, or undefined for anything else */
export function parseAppUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim())
    return undefined
  try {
    const url = new URL(value.trim())
    if (url.protocol !== 'https:' && url.protocol !== 'http:')
      return undefined
  }
  catch {
    return undefined
  }
  return value.trim().replace(TRAILING_SLASHES_RE, '')
}

export function configPath(root: string): string {
  return join(root, CONFIG_FILE)
}

/**
 * The nearest directory from `start` upwards that has a mavonengine.json.
 */
export function findConfigRoot(start: string): string | undefined {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    if (existsSync(configPath(dir)))
      return dir

    if (dirname(dir) === dir)
      return undefined
  }
}

/**
 * Read `<root>/mavonengine.json`. A missing file is an empty config; an unreadable one throws.
 */
export function readConfig(root: string): MavonEngineConfig {
  const path = configPath(root)
  if (!existsSync(path))
    return { plugins: {} }

  let config: unknown
  try {
    config = JSON.parse(readFileSync(path, 'utf8'))
  }
  catch (err) {
    throw new PluginConfigError(`${path} is not valid JSON: ${(err as Error).message}`)
  }

  if (!config || typeof config !== 'object' || Array.isArray(config))
    throw new PluginConfigError(`${path} must contain a JSON object`)

  const result = config as MavonEngineConfig
  if (result.plugins === undefined)
    result.plugins = {}
  else if (!result.plugins || typeof result.plugins !== 'object' || Array.isArray(result.plugins))
    throw new PluginConfigError(`"plugins" in ${path} must be an object`)

  return result
}

export function writeConfig(root: string, config: MavonEngineConfig): void {
  writeFileSync(configPath(root), `${JSON.stringify(config, null, 2)}\n`)
}

/**
 * Read, change and write mavonengine.json. Writes only when `change` returns true.
 */
export function updateConfig(root: string, change: (config: MavonEngineConfig) => boolean): boolean {
  const config = readConfig(root)
  if (!change(config))
    return false

  writeConfig(root, config)
  return true
}

/**
 * Add a plugin to mavonengine.json, keeping its settings if it is already there. Returns whether anything changed.
 */
export function addPluginToConfig(root: string, pkg: string): boolean {
  return updateConfig(root, (config) => {
    const existing = config.plugins[pkg]
    if (existing && existing.enabled !== false)
      return false

    config.plugins[pkg] = existing
      ? { ...existing, enabled: true }
      : { enabled: true }
    return true
  })
}

/**
 * Note that the project uses a plugin prefab, so its assets ship in the release. Returns whether anything changed.
 */
export function recordPrefabUsage(root: string, pkg: string, prefab: string): boolean {
  return updateConfig(root, (config) => {
    const entry = config.plugins[pkg]
    if (!entry)
      return false

    const prefabs = Array.isArray(entry.prefabs)
      ? entry.prefabs
      : []
    if (prefabs.includes(prefab))
      return false

    entry.prefabs = [...prefabs, prefab]
    return true
  })
}

/**
 * Directory of an installed package, looking in node_modules from `root` upwards like Node does,
 * so packages hoisted to a workspace root are found too.
 */
export function findPackageDir(root: string, pkg: string): string | undefined {
  for (let dir = resolve(root); ; dir = dirname(dir)) {
    const candidate = join(dir, 'node_modules', pkg)
    if (existsSync(join(candidate, 'package.json')))
      return candidate

    if (dirname(dir) === dir)
      return undefined
  }
}

/** The version of an installed package, found like `findPackageDir` does */
export function installedPackageVersion(root: string, pkg: string): string | undefined {
  const dir = findPackageDir(root, pkg)
  if (!dir)
    return undefined

  try {
    const version = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version
    return typeof version === 'string'
      ? version
      : undefined
  }
  catch {
    return undefined
  }
}

function validateManifest(pkg: string, value: unknown): PluginManifest {
  if (!value || typeof value !== 'object')
    throw new PluginConfigError(`${pkg}: "mavonengine" in package.json must be an object`)

  const manifest = value as PluginManifest
  if (!TARGETS.includes(manifest.target))
    throw new PluginConfigError(`${pkg}: "mavonengine.target" must be one of ${TARGETS.join(', ')}`)

  for (const side of ['client', 'server'] as const) {
    if (runsOn(manifest.target, side) && typeof manifest[side] !== 'string')
      throw new PluginConfigError(`${pkg}: "mavonengine.${side}" is required for target "${manifest.target}"`)
  }

  if (manifest.publish !== undefined && (typeof manifest.publish !== 'string' || !manifest.publish))
    throw new PluginConfigError(`${pkg}: "mavonengine.publish" must be a directory of the package`)

  if (manifest.dev !== undefined && (typeof manifest.dev !== 'string' || !manifest.dev))
    throw new PluginConfigError(`${pkg}: "mavonengine.dev" must be a file of the package`)

  if (manifest.reloadOnOptions !== undefined && typeof manifest.reloadOnOptions !== 'boolean')
    throw new PluginConfigError(`${pkg}: "mavonengine.reloadOnOptions" must be true or false`)

  return manifest
}

/**
 * The installed plugin `pkg`, or undefined when it is not installed or has no `mavonengine` field.
 * Throws PluginConfigError for an invalid manifest.
 */
export function readPluginManifest(root: string, pkg: string): InstalledPlugin | undefined {
  const dir = findPackageDir(root, pkg)
  if (!dir)
    return undefined

  const packageJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  if (packageJson.mavonengine === undefined)
    return undefined

  return {
    package: pkg,
    version: packageJson.version,
    dir,
    manifest: validateManifest(pkg, packageJson.mavonengine),
  }
}

export function runsOn(target: PluginTarget, side: 'client' | 'server'): boolean {
  return target === 'both' || target === side
}

/** The entry of `manifest` for `side`, undefined when the plugin has none there */
export function entryFor(manifest: PluginManifest, side: PluginSide): string | undefined {
  if (side === 'dev')
    return manifest.dev
  return runsOn(manifest.target, side)
    ? manifest[side]
    : undefined
}

/**
 * Resolve `path` inside `base`, refusing anything that points outside it.
 */
export function resolveInside(base: string, path: string): string | undefined {
  const full = resolve(base, path)
  const inside = relative(base, full)
  return inside && !inside.startsWith('..') && !isAbsolute(inside)
    ? full
    : undefined
}

export function assetsDir(plugin: InstalledPlugin): string {
  return resolve(plugin.dir, plugin.manifest.assets?.dir ?? 'assets')
}

/**
 * The enabled plugins in mavonengine.json that run on `side`, in config order. For `dev`, the ones with a dev entry.
 * Plugins that are missing or invalid are skipped and reported in `warnings`. Plugins made for another
 * @mavonengine/core are loaded, and reported in `incompatible`.
 */
export function enabledPlugins(root: string, side: PluginSide): { plugins: EnabledPlugin[], warnings: string[], incompatible: string[] } {
  const plugins: EnabledPlugin[] = []
  const warnings: string[] = []
  const incompatible: string[] = []
  const coreVersion = installedPackageVersion(root, '@mavonengine/core')

  for (const [pkg, entry] of Object.entries(readConfig(root).plugins)) {
    if (entry?.enabled === false)
      continue

    let installed: InstalledPlugin | undefined
    try {
      installed = readPluginManifest(root, pkg)
    }
    catch (err) {
      warnings.push((err as Error).message)
      continue
    }

    if (!installed) {
      warnings.push(`${pkg} is listed in ${CONFIG_FILE} but is not installed or is not a MavonEngine plugin`)
      continue
    }

    const entryFile = entryFor(installed.manifest, side)
    if (!entryFile)
      continue

    // Loaded anyway: the range may be too strict, and `mavonengine doctor` says what to do about it
    if (engineCompat(installed.manifest.engine, coreVersion) === 'incompatible') {
      incompatible.push(`${pkg}${installed.version
        ? ` ${installed.version}`
        : ''} is made for @mavonengine/core ${installed.manifest.engine}, the project has ${coreVersion}, run 'mavonengine doctor'`)
    }

    const entryPath = resolveInside(installed.dir, entryFile)
    if (!entryPath || !existsSync(entryPath)) {
      warnings.push(`${pkg}: ${side} entry ${entryFile} not found, is the plugin built?`)
      continue
    }

    plugins.push({
      ...installed,
      options: entry?.options ?? {},
      prefabs: Array.isArray(entry?.prefabs)
        ? entry.prefabs
        : [],
      entry: entryPath,
    })
  }

  return { plugins, warnings, incompatible }
}

/**
 * The asset paths of a plugin that ship in a release: the shared ones and those of the prefabs in use.
 */
export function shippedAssetPaths(manifest: PluginManifest, usedPrefabs: string[]): string[] {
  const assets = manifest.assets
  const paths = [
    ...(assets?.shared ?? []),
  ]
  for (const prefab of usedPrefabs)
    paths.push(...(assets?.prefabs?.[prefab] ?? []))

  return [
    ...new Set(paths),
  ]
}

/**
 * The plugin files that go into the client release. Paths that point outside a plugin's assets
 * directory or don't exist are reported in `warnings` and left out.
 */
export function releaseAssets(root: string): { assets: ReleaseAsset[], warnings: string[] } {
  const { plugins, warnings } = enabledPlugins(root, 'client')
  const assets: ReleaseAsset[] = []

  for (const plugin of plugins) {
    const base = assetsDir(plugin)
    for (const path of shippedAssetPaths(plugin.manifest, plugin.prefabs)) {
      const from = resolveInside(base, path)
      if (!from) {
        warnings.push(`${plugin.package}: asset ${path} points outside its assets directory`)
        continue
      }
      if (!existsSync(from)) {
        warnings.push(`${plugin.package}: asset ${path} not found`)
        continue
      }
      assets.push({
        package: plugin.package,
        from,
        to: `plugins/${plugin.package}/${path}`,
        path,
      })
    }
  }

  return { assets, warnings }
}

/** A README longer than this is cut off: it is sent to the editor whole */
export const MAX_README_CHARS = 200_000

const README_RE = /^readme(?:\.md|\.markdown|\.txt)?$/i

function readReadme(dir: string): string | undefined {
  try {
    const file = readdirSync(dir).find(name => README_RE.test(name))
    if (!file)
      return undefined

    const text = readFileSync(join(dir, file), 'utf8')
    return text.length > MAX_README_CHARS
      ? `${text.slice(0, MAX_README_CHARS)}\n\n… (cut off)`
      : text
  }
  catch {
    return undefined
  }
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value
    ? value
    : undefined
}

/**
 * Every plugin in mavonengine.json, turned off or not, with what its package says about itself.
 * A plugin that is missing or invalid is listed too, with the reason in `problem`.
 * Pass `readme: false` to leave the readmes out.
 */
export function pluginInfos(root: string, { readme = true }: { readme?: boolean } = {}): PluginInfo[] {
  return Object.entries(readConfig(root).plugins).map(([pkg, entry]) => {
    const info: PluginInfo = {
      package: pkg,
      enabled: entry?.enabled !== false,
      installed: false,
      declaredPrefabs: [],
      usedPrefabs: Array.isArray(entry?.prefabs)
        ? entry.prefabs.filter(prefab => typeof prefab === 'string')
        : [],
    }

    const dir = findPackageDir(root, pkg)
    if (!dir)
      return { ...info, problem: `Listed in ${CONFIG_FILE} but not installed` }

    let packageJson: Record<string, unknown>
    try {
      packageJson = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
    }
    catch (err) {
      return { ...info, problem: `Its package.json can't be read: ${(err as Error).message}` }
    }

    const repository = packageJson.repository as { url?: unknown } | string | undefined
    Object.assign(info, {
      version: text(packageJson.version),
      description: text(packageJson.description),
      license: text(packageJson.license),
      homepage: text(packageJson.homepage) ?? text(typeof repository === 'string'
        ? repository
        : repository?.url),
      readme: readme
        ? readReadme(dir)
        : undefined,
    })

    if (packageJson.mavonengine === undefined)
      return { ...info, problem: 'Not a MavonEngine plugin: its package.json has no "mavonengine" field' }

    let manifest: PluginManifest
    try {
      manifest = validateManifest(pkg, packageJson.mavonengine)
    }
    catch (err) {
      return { ...info, problem: (err as Error).message }
    }

    return {
      ...info,
      installed: true,
      target: manifest.target,
      engine: text(manifest.engine),
      declaredPrefabs: Object.keys(manifest.assets?.prefabs ?? {}),
    }
  })
}
