import type { PackageManager } from '../commands/dev'
import type { NpmRegistry, Packument } from '../doctor/npm'
import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { compareVersions, engineRangeOf, maxSatisfying, parseVersion, satisfies, validRange } from '@mavonengine/core/Plugins/compat'
import { findPackageDir } from '@mavonengine/core/Plugins/ProjectConfig'

/**
 * Which versions `mavonengine upgrade` moves the project's packages to: @mavonengine/core to its latest (or
 * `--to`), each plugin to its newest version whose `engine` range takes that core, and the other @mavonengine
 * packages to their newest version whose @mavonengine/core peer range takes it.
 */

export type DependencyField = 'dependencies' | 'devDependencies'

export interface Bump {
  name: string
  field: DependencyField
  /** What package.json says */
  spec: string
  /** What is installed */
  installed?: string
  /** Where it goes; undefined when it stays */
  to?: string
  plugin: boolean
  /** Why it stays, or can't go along */
  note?: string
  /** No published version works with the target core */
  blocked?: boolean
  /** package.json pins it to one version, so the new one is pinned too */
  exact: boolean
}

export interface UpgradePlan {
  core: { from?: string, to: string }
  bumps: Bump[]
}

export class UpgradeError extends Error {}

const EXACT_RE = /^v?\d+\.\d+\.\d+(?:-[\w.-]+)?$/
const REGISTRY_SPEC_RE = /^[\s\d.<>=^~xX*|v-]*$/

function installedJson(root: string, name: string): Record<string, any> | undefined {
  const dir = findPackageDir(root, name)
  const path = dir && join(dir, 'package.json')
  if (!path || !existsSync(path))
    return undefined
  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  catch {
    return undefined
  }
}

function stable(versions: string[]): string[] {
  return versions.filter(version => parseVersion(version)?.prerelease.length === 0)
}

function newer(a: string | undefined, than: string | undefined): boolean {
  const x = a && parseVersion(a)
  const y = than && parseVersion(than)
  return !!x && (!y || compareVersions(x, y) > 0)
}

/** The newest stable version of a package that works with core `core`, by `fits` */
function newestFitting(packument: Packument, fits: (json: Record<string, any>) => boolean): string | undefined {
  const versions = stable(Object.keys(packument.versions)).filter(version => fits(packument.versions[version]))
  return maxSatisfying(versions, '*')
}

/**
 * The plan for the project at `root`. Throws UpgradeError when the registry doesn't know @mavonengine/core or
 * `to` isn't one of its versions.
 */
export async function planUpgrade(root: string, packageJson: Record<string, any>, npm: NpmRegistry, to?: string): Promise<UpgradePlan> {
  const corePackument = await npm.get('@mavonengine/core')
  if (!corePackument)
    throw new UpgradeError(npm.unreachable ?? `${npm.url} doesn't know @mavonengine/core`)

  const target = to ?? corePackument.latest
  if (!target || !corePackument.versions[target]) {
    throw new UpgradeError(to
      ? `@mavonengine/core ${to} isn't published, see 'npm view @mavonengine/core versions'`
      : `${npm.url} has no latest @mavonengine/core`)
  }

  const fields: DependencyField[] = ['dependencies', 'devDependencies']
  const declared = fields.flatMap(field => Object.entries((packageJson[field] ?? {}) as Record<string, string>).map(([name, spec]) => ({
    name,
    spec: String(spec),
    field,
  })))

  const candidates = declared.filter(({ name }) => name.startsWith('@mavonengine/') || installedJson(root, name)?.mavonengine)
  const packuments = new Map(await Promise.all(candidates.map(async ({ name }) => [
    name,
    name === '@mavonengine/core'
      ? corePackument
      : await npm.get(name),
  ] as const)))
  if (npm.unreachable)
    throw new UpgradeError(npm.unreachable)

  const bumps = candidates.map(({ name, spec, field }): Bump => {
    const json = installedJson(root, name)
    const installed = typeof json?.version === 'string'
      ? json.version
      : undefined
    const plugin = !!json?.mavonengine || !!packuments.get(name)?.versions[packuments.get(name)?.latest ?? '']?.mavonengine
    const bump: Bump = {
      name,
      field,
      spec,
      installed,
      plugin,
      exact: EXACT_RE.test(spec.trim()),
    }

    if (!REGISTRY_SPEC_RE.test(spec) || !spec.trim())
      return { ...bump, note: `stays: ${spec} isn't from the registry` }

    const packument = packuments.get(name)
    if (!packument)
      return { ...bump, note: 'stays: not on the registry' }

    let version: string | undefined
    if (name === '@mavonengine/core') {
      version = target
    }
    else if (plugin) {
      version = newestFitting(packument, (v) => {
        const range = engineRangeOf(v)
        return !range || (validRange(range) && satisfies(target, range))
      })
      if (!version)
        return { ...bump, blocked: true, note: `no published version supports @mavonengine/core ${target}` }
    }
    else {
      version = newestFitting(packument, (v) => {
        const range = v.peerDependencies?.['@mavonengine/core']
        return typeof range !== 'string' || !validRange(range) || satisfies(target, range)
      })
    }

    // Never down, unless --to asks for an older core
    if (!version || version === installed || (name !== '@mavonengine/core' && !newer(version, installed)))
      return bump
    return { ...bump, to: version }
  })

  return {
    core: { from: installedJson(root, '@mavonengine/core')?.version, to: target },
    bumps,
  }
}

const DEV_FLAG: Record<PackageManager, string> = {
  npm: '--save-dev',
  pnpm: '--save-dev',
  yarn: '--dev',
  bun: '--dev',
}
const EXACT_FLAG: Record<PackageManager, string> = {
  npm: '--save-exact',
  pnpm: '--save-exact',
  yarn: '--exact',
  bun: '--exact',
}

/**
 * The install commands for the bumps: one per dependency field and pinning, so each package stays where it is
 * in package.json and pinned packages stay pinned.
 */
export function installCommands(pm: PackageManager, bumps: Bump[]): string[][] {
  const groups = new Map<string, { field: DependencyField, exact: boolean, specs: string[] }>()
  for (const bump of bumps) {
    if (!bump.to)
      continue
    const key = `${bump.field}:${bump.exact}`
    if (!groups.has(key))
      groups.set(key, { field: bump.field, exact: bump.exact, specs: [] })
    groups.get(key)!.specs.push(`${bump.name}@${bump.to}`)
  }

  return Array.from(groups.values(), ({ field, exact, specs }) => [
    pm === 'npm'
      ? 'install'
      : 'add',
    ...specs,
    ...(field === 'devDependencies'
      ? [DEV_FLAG[pm]]
      : []),
    ...(exact
      ? [EXACT_FLAG[pm]]
      : []),
  ])
}
