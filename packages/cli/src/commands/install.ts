import type { InstalledPlugin } from '@mavonengine/core/Plugins/ProjectConfig'
import type { PluginTarget } from '@mavonengine/core/Plugins/types'
import type { PackageManager } from './dev'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { addPluginToConfig, CONFIG_FILE, readConfig, readPluginManifest } from '@mavonengine/core/Plugins/ProjectConfig'
import { runCommand } from '../create/project'
import { UsageError } from './dashboard'
import { detectPackageManager, findProjectRoot, installedEngineVersion } from './dev'

export const INSTALL_HELP = `Usage: mavonengine install <package...> [options]

Install packages into the MavonEngine project you are in. For each one that is a
MavonEngine plugin, asks whether to add it to the plugins in ${CONFIG_FILE}, so it
loads on the client and/or the game server and is built into the release.

Takes anything your package manager does: names, name@version, file: paths, git URLs.

Options:
  --cwd <dir>        Start looking for the project here (default: current directory)
  -y, --yes          Add plugins to ${CONFIG_FILE} without asking
  --no-register      Only install, leave ${CONFIG_FILE} alone
  -h, --help         Show this help
`

export interface InstallOptions {
  cwd: string
  packages: string[]
  /** Register without asking */
  yes: boolean
  /** false with --no-register */
  register: boolean
}

export interface InstallIO {
  /** Run the package manager in `cwd`, rejecting on a non-zero exit */
  run(command: string, args: string[], cwd: string): Promise<void>
  /** Ask a yes/no question, resolving true for yes */
  confirm(question: string): Promise<boolean>
  interactive: boolean
  write(text: string): void
}

/** `@scope/name@range` or `name@range`, without the range */
const PACKAGE_SPEC_RE = /^((?:@[\w.-]+\/)?[\w.-]+)(?:@.*)?$/
/** `./x`, `../x`, `/x`, `~/x` or `C:\x` */
const LOCAL_PATH_RE = /^(?:\.{1,2}(?:[/\\]|$)|[/~]|[a-z]:[/\\])/i

const TARGET_LABELS: Record<PluginTarget, string> = {
  client: 'client only',
  server: 'server only',
  both: 'client + server',
}

/**
 * Turn CLI arguments into install options. Throws UsageError on bad input.
 */
export function parseInstallArgs(args: string[], cwd = process.cwd()): InstallOptions | 'help' {
  const { values, positionals } = parseArgs({
    args,
    options: {
      cwd: { type: 'string' },
      yes: { type: 'boolean', short: 'y', default: false },
      register: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
    allowNegative: true,
  })

  if (values.help)
    return 'help'

  if (positionals.length === 0)
    throw new UsageError(`which package? e.g. mavonengine install my-plugin\n\n${INSTALL_HELP}`)

  return { cwd: resolve(cwd, values.cwd ?? '.'), packages: positionals, yes: values.yes, register: values.register }
}

/**
 * The package name in an install spec. For a local directory (`file:../x`, `./x`) it is read from its package.json,
 * resolved from `root` like the package manager does. Undefined for specs without one (git URLs, tarballs).
 */
export function packageNameFromSpec(spec: string, root: string): string | undefined {
  const localPath = spec.startsWith('file:') ? spec.slice('file:'.length) : LOCAL_PATH_RE.test(spec) ? spec : undefined
  if (localPath !== undefined) {
    const packageJson = join(resolve(root, localPath), 'package.json')
    try {
      return existsSync(packageJson) ? JSON.parse(readFileSync(packageJson, 'utf8')).name : undefined
    }
    catch {
      return undefined
    }
  }

  if (spec.includes(':') || spec.endsWith('.tgz'))
    return undefined

  return PACKAGE_SPEC_RE.exec(spec)?.[1]
}

export function installArgs(pm: PackageManager, packages: string[]): string[] {
  return [pm === 'npm' ? 'install' : 'add', ...packages]
}

function dependencyNames(root: string): Map<string, string> {
  const path = join(root, 'package.json')
  if (!existsSync(path))
    return new Map()

  const pkg = JSON.parse(readFileSync(path, 'utf8'))
  return new Map(Object.entries({ ...pkg.devDependencies, ...pkg.dependencies }) as [string, string][])
}

/**
 * The names of what was installed: from the specs where they say, and from what changed in package.json
 * for specs that don't (file: paths, git URLs).
 */
export function installedNames(specs: string[], root: string, before: Map<string, string>, after: Map<string, string>): string[] {
  const names = specs.map(spec => packageNameFromSpec(spec, root)).filter((name): name is string => !!name)
  for (const [name, version] of after) {
    if (before.get(name) !== version)
      names.push(name)
  }
  return [...new Set(names)]
}

export function describePlugin(plugin: InstalledPlugin, engineVersion: string | undefined): string {
  const { manifest } = plugin
  const lines = [`${plugin.package}${plugin.version ? `@${plugin.version}` : ''} is a MavonEngine plugin (${TARGET_LABELS[manifest.target]})`]

  const prefabs = Object.keys(manifest.assets?.prefabs ?? {})
  if (prefabs.length)
    lines.push(`  Prefabs: ${prefabs.join(', ')}. Their assets ship in the release once you place them in the editor`)

  if (manifest.engine)
    lines.push(`  Made for @mavonengine/core ${manifest.engine}${engineVersion ? `, you have ${engineVersion}` : ''}`)

  return `${lines.join('\n')}\n`
}

function confirmOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return rl.question(question)
    .then(answer => ['', 'y', 'yes'].includes(answer.trim().toLowerCase()))
    .finally(() => rl.close())
}

const terminalIO: InstallIO = {
  run: (command, args, cwd) => runCommand(command, args, cwd, {
    report: { step: () => {}, output: chunk => process.stdout.write(chunk) },
  }),
  confirm: confirmOnTerminal,
  get interactive() {
    return !!process.stdin.isTTY && !!process.stdout.isTTY
  },
  write: text => process.stdout.write(text),
}

/**
 * Install the packages, then offer to register the plugins among them in mavonengine.json.
 */
export async function runInstallCommand(options: InstallOptions, io: InstallIO = terminalIO): Promise<number> {
  const root = findProjectRoot(options.cwd)
  if (!root)
    throw new UsageError(`no MavonEngine project found in ${options.cwd} or its parents (looking for a package.json with @mavonengine/core and a dev script)`)

  // Fail on a broken mavonengine.json before installing anything
  const config = readConfig(root)

  const pm = detectPackageManager(root)
  const args = installArgs(pm, options.packages)
  const before = dependencyNames(root)
  io.write(`mavonengine: running '${pm} ${args.join(' ')}' in ${root}\n`)
  await io.run(pm, args, root)

  const engineVersion = installedEngineVersion(root)
  let failed = false

  const names = installedNames(options.packages, root, before, dependencyNames(root))
  if (names.length === 0)
    io.write(`\nmavonengine: couldn't tell which packages were installed. If one is a plugin, run 'mavonengine install <its name>' to register it\n`)

  for (const name of names) {
    let plugin: InstalledPlugin | undefined
    try {
      plugin = readPluginManifest(root, name)
    }
    catch (err) {
      io.write(`\nmavonengine: ${(err as Error).message}\n`)
      failed = true
      continue
    }

    if (!plugin) {
      io.write(`\n${name} is installed. It is not a MavonEngine plugin (no "mavonengine" field in its package.json), so ${CONFIG_FILE} is left alone\n`)
      continue
    }

    io.write(`\n${describePlugin(plugin, engineVersion)}`)

    const entry = config.plugins[name]
    if (entry && entry.enabled !== false) {
      io.write(`  Already in ${CONFIG_FILE}\n`)
      continue
    }

    if (!options.register)
      continue

    if (!options.yes && !io.interactive) {
      io.write(`  Not added to ${CONFIG_FILE}: run with --yes, or add "${name}": { "enabled": true } to its "plugins"\n`)
      continue
    }

    if (!options.yes && !await io.confirm(`Add ${name} to the plugins in ${CONFIG_FILE}? (Y/n) `)) {
      io.write(`  Not added. Add "${name}": { "enabled": true } to "plugins" in ${CONFIG_FILE} to use it later\n`)
      continue
    }

    addPluginToConfig(root, name)
    io.write(`  Added to ${join(root, CONFIG_FILE)}\n`)
    if (plugin.manifest.target !== 'client')
      io.write(`  Restart the game server ('mavonengine dev') to load it there\n`)
  }

  return failed ? 1 : 0
}
