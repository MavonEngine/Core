import type { MavonEngineConfig, PluginManifest } from '@mavonengine/core/Plugins/ProjectConfig'
import type { PackageManager } from '../commands/dev'
import type { NpmRegistry } from './npm'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions, engineCompat, engineRangeOf, maxSatisfying, parseVersion, satisfies, validRange } from '@mavonengine/core/Plugins/compat'
import { assetsDir, CONFIG_FILE, configPath, findPackageDir, parseAppUrl, resolveInside, runsOn, shippedAssetPaths } from '@mavonengine/core/Plugins/ProjectConfig'
import { loadMigrations } from '../upgrade/migrations'

export type Level = 'ok' | 'info' | 'warn' | 'error'

export type Group = 'Environment' | typeof CONFIG_FILE | 'Plugins' | 'Migrations'

export const GROUPS: Group[] = [
  'Environment',
  CONFIG_FILE,
  'Plugins',
  'Migrations',
]

export interface Finding {
  group: Group
  level: Level
  /** What was looked at, e.g. `Node 24.4.0` */
  label: string
  /** What was found */
  detail?: string
  /** What to run or change about it */
  fix?: string
}

export interface DoctorContext {
  root: string
  packageManager: PackageManager
  /** The project's package.json */
  packageJson: Record<string, any>
  nodeVersion: string
  /** Undefined with --offline */
  npm?: NpmRegistry
}

/** What the CLI needs, from its own package.json */
export const CLI_NODE_RANGE = '>=24'

const TOP_LEVEL_KEYS = new Set([
  '$schema',
  'plugins',
  'database',
  'auth',
  'notifications',
  'appUrl',
  'appName',
  'migrations',
])
const PROVIDER_KEYS = ['database', 'auth', 'notifications'] as const
const PLAIN_SPEC_RE = /^[\s\d.<>=^~x*|-]+$/i

function readJson(path: string): Record<string, any> | undefined {
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  catch {
    return undefined
  }
}

function installedPackageJson(root: string, pkg: string): Record<string, any> | undefined {
  const dir = findPackageDir(root, pkg)
  return dir
    ? readJson(join(dir, 'package.json'))
    : undefined
}

/** The @mavonengine/core version installed in the project */
export function coreVersionOf(root: string): string | undefined {
  const version = installedPackageJson(root, '@mavonengine/core')?.version
  return typeof version === 'string'
    ? version
    : undefined
}

export function installCommand(pm: PackageManager, spec = ''): string {
  return `${pm} ${pm === 'npm'
    ? 'install'
    : spec ? 'add' : 'install'}${spec
    ? ` ${spec}`
    : ''}`
}

function isNewer(candidate: string | undefined, than: string | undefined): candidate is string {
  const a = candidate
    ? parseVersion(candidate)
    : undefined
  const b = than
    ? parseVersion(than)
    : undefined
  return !!a && !!b && compareVersions(a, b) > 0
}

// ---------------------------------------------------------------------------------------------------------------------
// Environment

/**
 * Node, and the @mavonengine packages in the project's package.json: installed, matching what package.json asks
 * for, and whether npm has newer ones.
 */
export async function checkEnvironment(ctx: DoctorContext): Promise<Finding[]> {
  const findings: Finding[] = []
  const add = (finding: Omit<Finding, 'group'>) => findings.push({ group: 'Environment', ...finding })

  // Node: what the CLI needs and what the installed core says it needs
  const coreJson = installedPackageJson(ctx.root, '@mavonengine/core')
  const needs = [CLI_NODE_RANGE, coreJson?.engines?.node].filter((range): range is string => typeof range === 'string' && validRange(range))
  const unmet = needs.filter(range => !satisfies(ctx.nodeVersion, range))
  add(unmet.length
    ? {
        level: 'error',
        label: `Node ${ctx.nodeVersion}`,
        detail: `needs ${unmet.join(' and ')}`,
        fix: 'install a newer Node, e.g. from https://nodejs.org',
      }
    : { level: 'ok', label: `Node ${ctx.nodeVersion}`, detail: `needs ${[
        ...new Set(needs),
      ].join(' and ')}` })

  const declared = {
    ...ctx.packageJson.devDependencies,
    ...ctx.packageJson.dependencies,
  } as Record<string, string>
  const packages = Object.keys(declared).filter(name => name.startsWith('@mavonengine/'))
  // Plugins are looked at under Plugins
  const engine = packages.filter((name) => {
    const json = installedPackageJson(ctx.root, name)
    return !json || json.mavonengine === undefined
  })

  const packuments = new Map(await Promise.all(engine.map(async name => [name, await ctx.npm?.get(name)] as const)))

  for (const name of engine) {
    const spec = String(declared[name])
    const json = installedPackageJson(ctx.root, name)
    const version = typeof json?.version === 'string'
      ? json.version
      : undefined

    if (!version) {
      add({
        level: 'error',
        label: name,
        detail: `in package.json (${spec}) but not installed`,
        fix: installCommand(ctx.packageManager),
      })
      continue
    }

    // Only plain ranges can be compared; file:, workspace: and git specs are what they are
    if (PLAIN_SPEC_RE.test(spec) && validRange(spec) && !satisfies(version, spec)) {
      add({
        level: 'error',
        label: `${name} ${version}`,
        detail: `package.json asks for ${spec}`,
        fix: installCommand(ctx.packageManager),
      })
      continue
    }

    const latest = packuments.get(name)?.latest
    if (isNewer(latest, version))
      add({ level: 'info', label: `${name} ${version}`, detail: `${latest} is out` })
    else
      add({ level: 'ok', label: `${name} ${version}` })
  }

  if (!packages.includes('@mavonengine/core')) {
    add({
      level: 'error',
      label: '@mavonengine/core',
      detail: 'not in package.json',
      fix: installCommand(ctx.packageManager, '@mavonengine/core'),
    })
  }

  return findings
}

/** Said once, after every check that asked npm */
export function registryFinding(npm: NpmRegistry | undefined): Finding | undefined {
  if (npm?.unreachable) {
    return {
      group: 'Environment',
      level: 'warn',
      label: 'npm registry',
      detail: `${npm.unreachable}, so newer versions weren't looked for`,
      fix: 'check the connection, or pass --offline',
    }
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// mavonengine.json

export interface ConfigResult {
  findings: Finding[]
  /** Undefined when the file can't be read */
  config?: MavonEngineConfig
}

/**
 * mavonengine.json: readable, and its project settings make sense. The plugins in it are looked at under Plugins.
 */
export function checkConfig(root: string, env: Record<string, string | undefined> = {}): ConfigResult {
  const findings: Finding[] = []
  const add = (finding: Omit<Finding, 'group'>) => findings.push({ group: CONFIG_FILE, ...finding })
  const path = configPath(root)

  if (!existsSync(path)) {
    add({
      level: 'info',
      label: CONFIG_FILE,
      detail: 'there is none, so no plugins are loaded',
      fix: 'mavonengine install <plugin> creates it',
    })
    return {
      findings,
      config: { plugins: {} },
    }
  }

  let raw: unknown
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'))
  }
  catch (err) {
    add({ level: 'error', label: CONFIG_FILE, detail: `not valid JSON: ${(err as Error).message}` })
    return { findings }
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    add({ level: 'error', label: CONFIG_FILE, detail: 'must contain a JSON object' })
    return { findings }
  }

  const config = raw as MavonEngineConfig
  if (config.plugins !== undefined && (!config.plugins || typeof config.plugins !== 'object' || Array.isArray(config.plugins))) {
    add({ level: 'error', label: `${CONFIG_FILE} plugins`, detail: 'must be an object of package names' })
    return { findings }
  }
  config.plugins ??= {}

  add({ level: 'ok', label: CONFIG_FILE, detail: `${Object.keys(config.plugins).length} plugin${Object.keys(config.plugins).length === 1
    ? ''
    : 's'}` })

  for (const key of Object.keys(config)) {
    if (!TOP_LEVEL_KEYS.has(key))
      add({ level: 'info', label: `"${key}"`, detail: 'is not a setting MavonEngine knows, a typo?' })
  }

  if (config.appUrl !== undefined) {
    const url = parseAppUrl(config.appUrl)
    if (!url) {
      add({
        level: 'error',
        label: `appUrl ${JSON.stringify(config.appUrl)}`,
        detail: 'is not an http(s) URL',
        fix: 'e.g. "appUrl": "https://mygame.com"',
      })
    }
    else {
      add({
        level: 'ok',
        label: `appUrl ${url}`,
        detail: env.MAVONENGINE_APP_URL
          ? `MAVONENGINE_APP_URL overrides it here: ${env.MAVONENGINE_APP_URL}`
          : undefined,
      })
    }
  }

  if (config.appName !== undefined && (typeof config.appName !== 'string' || !config.appName.trim()))
    add({ level: 'warn', label: 'appName', detail: 'should be the game\'s name, as text' })

  for (const key of PROVIDER_KEYS) {
    const pkg = config[key]
    if (pkg === undefined)
      continue

    if (typeof pkg !== 'string') {
      add({ level: 'error', label: `${key}`, detail: 'should be the package name of a plugin in "plugins"' })
    }
    else if (!config.plugins[pkg]) {
      add({
        level: 'error',
        label: `${key}: ${pkg}`,
        detail: 'is not in "plugins"',
        fix: `mavonengine install ${pkg}`,
      })
    }
    else if (config.plugins[pkg]?.enabled === false) {
      add({ level: 'warn', label: `${key}: ${pkg}`, detail: 'is turned off in "plugins"' })
    }
  }

  for (const [pkg, entry] of Object.entries(config.plugins)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      add({ level: 'error', label: `plugins["${pkg}"]`, detail: 'must be an object, e.g. { "enabled": true }' })
      continue
    }
    if (entry.enabled !== undefined && typeof entry.enabled !== 'boolean')
      add({ level: 'warn', label: `plugins["${pkg}"].enabled`, detail: 'should be true or false' })
    if (entry.prefabs !== undefined && (!Array.isArray(entry.prefabs) || entry.prefabs.some(prefab => typeof prefab !== 'string')))
      add({ level: 'warn', label: `plugins["${pkg}"].prefabs`, detail: 'should be a list of prefab names' })
    if (entry.options !== undefined && (!entry.options || typeof entry.options !== 'object' || Array.isArray(entry.options)))
      add({ level: 'warn', label: `plugins["${pkg}"].options`, detail: 'should be an object' })
  }

  return { findings, config }
}

// ---------------------------------------------------------------------------------------------------------------------
// Plugins

/**
 * The newest published version of a plugin that supports @mavonengine/core `coreVersion`, and the newest core one of
 * its versions supports at all.
 */
async function compatibleVersions(npm: NpmRegistry | undefined, pkg: string, coreVersion: string) {
  const packument = await npm?.get(pkg)
  if (!packument)
    return {}

  const supporting = Object.entries(packument.versions)
    .filter(([, json]) => engineCompat(engineRangeOf(json), coreVersion) === 'compatible')
    .map(([version]) => version)

  return {
    forCore: maxSatisfying(supporting, '*'),
    latest: packument.latest,
    packument,
  }
}

/**
 * Every plugin in mavonengine.json: installed, a valid plugin, built, made for the project's @mavonengine/core,
 * with the assets of the prefabs in use. Also plugins installed but not in mavonengine.json.
 */
export async function checkPlugins(ctx: DoctorContext, config: MavonEngineConfig): Promise<Finding[]> {
  const findings: Finding[] = []
  const add = (finding: Omit<Finding, 'group'>) => findings.push({ group: 'Plugins', ...finding })
  const coreVersion = coreVersionOf(ctx.root)
  const entries = Object.entries(config.plugins).filter(([, entry]) => entry && typeof entry === 'object')

  const results = await Promise.all(entries.map(async ([pkg, entry]) => {
    const found: Omit<Finding, 'group'>[] = []
    const enabled = entry.enabled !== false
    const dir = findPackageDir(ctx.root, pkg)
    const json = dir
      ? readJson(join(dir, 'package.json'))
      : undefined

    if (!dir || !json) {
      found.push({
        level: enabled ? 'error' : 'warn',
        label: pkg,
        detail: `in ${CONFIG_FILE} but not installed`,
        fix: `mavonengine install ${pkg}`,
      })
      return found
    }

    const label = `${pkg}${json.version
      ? ` ${json.version}`
      : ''}`
    if (json.mavonengine === undefined || !json.mavonengine || typeof json.mavonengine !== 'object') {
      found.push({ level: 'error', label, detail: 'not a MavonEngine plugin: its package.json has no "mavonengine" field' })
      return found
    }

    const manifest = json.mavonengine as PluginManifest
    if (!['client', 'server', 'both'].includes(manifest.target)) {
      found.push({ level: 'error', label, detail: '"mavonengine.target" must be client, server or both' })
      return found
    }

    if (!enabled) {
      found.push({ level: 'info', label, detail: 'turned off' })
      return found
    }

    // Built: the entry of every side it runs on is there
    for (const side of ['client', 'server'] as const) {
      if (!runsOn(manifest.target, side))
        continue
      const file = typeof manifest[side] === 'string'
        ? resolveInside(dir, manifest[side])
        : undefined
      if (!file || !existsSync(file))
        found.push({ level: 'error', label, detail: `${side} entry ${manifest[side] ?? '(none)'} not found, is the plugin built?` })
    }

    // The dev entry runs in the client's dev server, whatever the target. Missing only breaks the editor's tooling
    if (manifest.dev !== undefined) {
      const file = typeof manifest.dev === 'string' && manifest.dev
        ? resolveInside(dir, manifest.dev)
        : undefined
      if (!file || !existsSync(file)) {
        found.push({ level: 'warn', label, detail: `dev entry ${typeof manifest.dev === 'string'
          ? manifest.dev
          : '(invalid)'} not found, is the plugin built?` })
      }
    }

    // The assets of the prefabs in use
    const prefabs = Array.isArray(entry.prefabs)
      ? entry.prefabs.filter(prefab => typeof prefab === 'string')
      : []
    const base = assetsDir({ package: pkg, dir, manifest })
    const missing = shippedAssetPaths(manifest, prefabs).filter((path) => {
      const file = resolveInside(base, path)
      return !file || !existsSync(file)
    })
    if (missing.length) {
      found.push({ level: 'warn', label, detail: `asset${missing.length === 1
        ? ''
        : 's'} missing from the release: ${missing.join(', ')}` })
    }

    if (manifest.publish && !existsSync(join(dir, manifest.publish)))
      found.push({ level: 'warn', label, detail: `"mavonengine.publish" directory ${manifest.publish} is not in the package` })

    // Made for this core
    const range = engineRangeOf(json)
    if (!range) {
      found.push({ level: 'info', label, detail: 'doesn\'t say which @mavonengine/core it supports ("mavonengine.engine")' })
    }
    else if (!validRange(range)) {
      found.push({ level: 'warn', label, detail: `"mavonengine.engine" ${JSON.stringify(range)} is not a semver range` })
    }
    else if (coreVersion && !satisfies(coreVersion, range)) {
      const { forCore } = await compatibleVersions(ctx.npm, pkg, coreVersion)
      found.push({
        level: 'error',
        label,
        detail: `made for @mavonengine/core ${range}, the project has ${coreVersion}`,
        fix: forCore
          ? `mavonengine install ${pkg}@${forCore}`
          : `no published version supports core ${coreVersion}; move @mavonengine/core into ${range}`,
      })
    }
    else if (coreVersion) {
      const { forCore } = await compatibleVersions(ctx.npm, pkg, coreVersion)
      if (isNewer(forCore, json.version)) {
        found.push({
          level: 'info',
          label,
          detail: `core ${range}; ${forCore} is out and supports core ${coreVersion}`,
          fix: `mavonengine install ${pkg}@${forCore}`,
        })
      }
    }

    if (!found.some(finding => finding.label === label)) {
      found.push({
        level: 'ok',
        label,
        detail: range
          ? `core ${range}`
          : undefined,
      })
    }

    return found
  }))

  for (const found of results) {
    for (const finding of found)
      add(finding)
  }

  // Installed and a plugin, but not in mavonengine.json
  const declared = Object.keys({
    ...ctx.packageJson.devDependencies,
    ...ctx.packageJson.dependencies,
  })
  for (const pkg of declared) {
    if (config.plugins[pkg] !== undefined)
      continue
    const json = installedPackageJson(ctx.root, pkg)
    if (json?.mavonengine && typeof json.mavonengine === 'object') {
      add({
        level: 'info',
        label: pkg,
        detail: `a plugin that is installed but not in ${CONFIG_FILE}, so it isn't loaded`,
        fix: `mavonengine install ${pkg}`,
      })
    }
  }

  if (!findings.length)
    add({ level: 'ok', label: 'no plugins' })

  return findings
}

// ---------------------------------------------------------------------------------------------------------------------
// Migrations

/**
 * The migrations the project's core has that the project hasn't had.
 */
export async function checkMigrations(ctx: DoctorContext, cliVersion?: string): Promise<Finding[]> {
  const coreVersion = coreVersionOf(ctx.root)
  if (!coreVersion)
    return []

  const { module } = await loadMigrations(ctx.root)
  let pending
  try {
    pending = module.pendingMigrations({
      files: new module.ProjectFiles(ctx.root),
      versions: { core: coreVersion, cli: cliVersion },
    })
  }
  catch (err) {
    return [
      {
        group: 'Migrations',
        level: 'warn',
        label: 'migrations',
        detail: `can't be checked: ${(err as Error).message}`,
      },
    ]
  }

  if (!pending.length) {
    return [
      { group: 'Migrations', level: 'ok', label: 'none pending' },
    ]
  }

  return pending.map((migration, index) => ({
    group: 'Migrations' as const,
    level: 'warn' as const,
    label: migration.id,
    detail: migration.description,
    fix: index === pending.length - 1
      ? 'mavonengine upgrade --only-migrations'
      : undefined,
  }))
}
