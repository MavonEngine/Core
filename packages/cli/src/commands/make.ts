import type { PluginTarget } from '@mavonengine/core/Plugins/types'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { addPluginToConfig, CONFIG_FILE, findPackageDir, readConfig } from '@mavonengine/core/Plugins/ProjectConfig'
import { runCommand } from '../create/project'
import { linkPlugin, pluginDirFor, pluginFiles } from '../make/plugin'
import { PACKAGE_NAME_RE, writeScaffold } from '../make/scaffold'
import { UsageError } from './dashboard'
import { detectPackageManager, findProjectRoot, installedEngineVersion } from './dev'

const TARGETS: PluginTarget[] = ['client', 'server', 'both']

export const MAKE_PLUGIN_HELP = `Usage: mavonengine make:plugin <name> [options]

Create a plugin inside the MavonEngine project you are in, in plugins/<name>/.
It is linked as a workspace, registered in ${CONFIG_FILE} and runs from its
TypeScript sources, so 'mavonengine dev' loads it without a build step.

<name> is the plugin's package name, e.g. forest or @acme/forest.

Options:
  --target <side>    client, server or both (default: both)
  --cwd <dir>        Start looking for the project here (default: current directory)
  --no-register      Leave ${CONFIG_FILE} alone
  --no-install       Don't run the package manager to link the plugin
  -h, --help         Show this help
`

export interface MakePluginOptions {
  cwd: string
  name: string
  target: PluginTarget
  /** false with --no-register */
  register: boolean
  /** false with --no-install */
  install: boolean
}

export interface MakeIO {
  /** Run the package manager in `cwd`, rejecting on a non-zero exit */
  run(command: string, args: string[], cwd: string): Promise<void>
  write(text: string): void
}

/**
 * Turn CLI arguments into make:plugin options. Throws UsageError on bad input.
 */
export function parseMakePluginArgs(args: string[], cwd = process.cwd()): MakePluginOptions | 'help' {
  const { values, positionals } = parseArgs({
    args,
    options: {
      target: { type: 'string', default: 'both' },
      cwd: { type: 'string' },
      register: { type: 'boolean', default: true },
      install: { type: 'boolean', default: true },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
    allowNegative: true,
  })

  if (values.help)
    return 'help'

  if (positionals.length === 0)
    throw new UsageError(`name the plugin, e.g. mavonengine make:plugin forest\n\n${MAKE_PLUGIN_HELP}`)
  if (positionals.length > 1)
    throw new UsageError(`expected one plugin name, got ${positionals.length}`)

  const name = positionals[0].trim()
  if (!PACKAGE_NAME_RE.test(name))
    throw new UsageError(`'${name}' is not a package name: use lower case letters, digits and - . _ ~, optionally with a @scope/`)

  const target = values.target as PluginTarget
  if (!TARGETS.includes(target))
    throw new UsageError(`--target must be one of ${TARGETS.join(', ')}`)

  return {
    cwd: resolve(cwd, values.cwd ?? '.'),
    name,
    target,
    register: values.register,
    install: values.install,
  }
}

const terminalIO: MakeIO = {
  run: (command, args, cwd) => runCommand(command, args, cwd, {
    report: {
      step: () => {},
      output: chunk => process.stdout.write(chunk),
    },
  }),
  write: text => process.stdout.write(text),
}

/**
 * Write the plugin, link it as a workspace, register it in mavonengine.json and install so it is linked.
 */
export async function runMakePluginCommand(options: MakePluginOptions, io: MakeIO = terminalIO): Promise<number> {
  const root = findProjectRoot(options.cwd)
  if (!root)
    throw new UsageError(`no MavonEngine project found in ${options.cwd} or its parents (looking for a package.json with @mavonengine/core and a dev script)`)

  // Fail on a broken mavonengine.json before writing anything
  const config = readConfig(root)
  if (config.plugins[options.name])
    throw new UsageError(`${options.name} is already in ${CONFIG_FILE}`)
  if (findPackageDir(root, options.name))
    throw new UsageError(`a package named ${options.name} is already installed, pick another name`)

  const dir = pluginDirFor(options.name)
  const engineVersion = installedEngineVersion(root)
  const files = pluginFiles({
    name: options.name,
    target: options.target,
    engine: engineVersion
      ? `>=${engineVersion}`
      : undefined,
  })

  let written: string[]
  try {
    written = writeScaffold(join(root, dir), files)
  }
  catch (err) {
    throw new UsageError((err as Error).message)
  }

  io.write(`mavonengine: created ${options.name} in ${dir}/\n`)
  for (const path of written)
    io.write(`  ${dir}/${path}\n`)

  const pm = detectPackageManager(root)
  const linked = linkPlugin(root, pm, options.name, dir)
  if (linked)
    io.write(`  package.json: ${linked}\n`)

  if (options.register) {
    addPluginToConfig(root, options.name)
    io.write(`  ${CONFIG_FILE}: added ${options.name}\n`)
  }

  if (options.install) {
    io.write(`\nmavonengine: running '${pm} install' in ${root} to link it\n`)
    try {
      await io.run(pm, ['install'], root)
    }
    catch (err) {
      io.write(`\nmavonengine: ${(err as Error).message}. The plugin is written; run '${pm} install' to link it\n`)
      return 1
    }
  }

  const next = [
    !options.install && `run '${pm} install' to link it`,
    !options.register && `add "${options.name}": { "enabled": true } to "plugins" in ${CONFIG_FILE} to load it`,
    `edit ${dir}/src/ and run 'mavonengine dev'`,
  ].filter(Boolean)
  io.write(`\nNext: ${next.join(', then ')}\n`)
  return 0
}
