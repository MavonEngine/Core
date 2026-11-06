import type { ReleaseAsset } from '@mavonengine/core/Plugins/ProjectConfig'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { CONFIG_FILE, readConfig, releaseAssets } from '@mavonengine/core/Plugins/ProjectConfig'
import { UsageError } from './dashboard'
import { detectPackageManager, findProjectRoot } from './dev'

export const BUILD_HELP = `Usage: mavonengine build [options]

Build the MavonEngine project you are in for release by running its build script.
Plugin assets go into the client's output under plugins/<package>/: the shared
ones, and those of the prefabs listed in ${CONFIG_FILE}. The others are left out.

Options:
  --cwd <dir>        Start looking for the project here (default: current directory)
  -h, --help         Show this help
`

export interface BuildOptions {
  cwd: string
}

export function parseBuildArgs(args: string[], cwd = process.cwd()): BuildOptions | 'help' {
  const { values } = parseArgs({
    args,
    options: {
      cwd: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  })

  if (values.help)
    return 'help'

  return { cwd: resolve(cwd, values.cwd ?? '.') }
}

/**
 * What the release contains from each plugin, one line per plugin.
 */
export function summarizeReleaseAssets(root: string, assets: ReleaseAsset[], warnings: string[]): string {
  const plugins = readConfig(root).plugins
  const enabled = Object.entries(plugins).filter(([, entry]) => entry?.enabled !== false)
  if (enabled.length === 0)
    return ''

  const lines = [`\nPlugins in ${CONFIG_FILE}:`]
  for (const [pkg, entry] of enabled) {
    const count = assets.filter(a => a.package === pkg).length
    const prefabs = entry?.prefabs?.length ? `, prefabs: ${entry.prefabs.join(', ')}` : ''
    lines.push(`  ${pkg}: ${count} asset${count === 1 ? '' : 's'}${prefabs}`)
  }
  for (const warning of warnings)
    lines.push(`  warning: ${warning}`)

  return `${lines.join('\n')}\n`
}

function run(command: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    child.on('error', (err: NodeJS.ErrnoException) => {
      reject(err.code === 'ENOENT' ? new Error(`'${command}' was not found on your PATH`) : err)
    })
    child.on('exit', code => resolvePromise(code ?? 1))
  })
}

export async function runBuildCommand(options: BuildOptions): Promise<number> {
  const root = findProjectRoot(options.cwd)
  if (!root)
    throw new UsageError(`no MavonEngine project found in ${options.cwd} or its parents (looking for a package.json with @mavonengine/core and a dev script)`)

  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  if (typeof pkg.scripts?.build !== 'string')
    throw new UsageError(`${join(root, 'package.json')} has no build script`)

  const pm = detectPackageManager(root)
  process.stdout.write(`mavonengine: running '${pm} run build' in ${root}\n`)
  const code = await run(pm, ['run', 'build'], root)
  if (code !== 0) {
    process.stderr.write(`mavonengine: the build script exited with code ${code}\n`)
    return code
  }

  if (existsSync(join(root, CONFIG_FILE))) {
    const { assets, warnings } = releaseAssets(root)
    process.stdout.write(summarizeReleaseAssets(root, assets, warnings))
  }

  return 0
}
