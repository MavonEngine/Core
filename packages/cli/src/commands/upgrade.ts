import type { Bump, UpgradePlan } from '../upgrade/plan'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { parseVersion } from '@mavonengine/core/Plugins/compat'
import { CONFIG_FILE } from '@mavonengine/core/Plugins/ProjectConfig'
import { version as cliVersion } from '../../package.json'
import { runCommand } from '../create/project'
import { coreVersionOf } from '../doctor/checks'
import { NPM_REGISTRY_URL, NpmRegistry } from '../doctor/npm'
import { lineDiff } from '../upgrade/diff'
import { loadMigrations } from '../upgrade/migrations'
import { installCommands, planUpgrade, UpgradeError } from '../upgrade/plan'
import { UsageError } from './dashboard'
import { detectPackageManager, findProjectRoot } from './dev'
import { formatReport, runDoctor } from './doctor'

export const UPGRADE_HELP = `Usage: mavonengine upgrade [options]

Move the MavonEngine project you are in to the latest @mavonengine/core, then migrate it.

1. Packages: @mavonengine/core goes to its latest version (or --to), each plugin to its
   newest version whose "engine" range takes that core, the other @mavonengine packages
   to their newest. Versions come from the npm registry. A plugin with no version for
   that core stops the upgrade, unless --force.
2. Migrations: the changes the new core needs in the project's files, from the installed
   core. Each is shown as a diff first and recorded in ${CONFIG_FILE} once applied.
3. 'mavonengine doctor' on the result.

Asks before installing and before writing. Refuses to start with uncommitted changes in
git, so every change can be looked at and undone.

Options:
  --to <version>       Move @mavonengine/core to this version instead of the latest
  --only-migrations    Leave the packages alone, only migrate (after installing yourself)
  --dry-run            Show what would happen, change nothing
  -y, --yes            Don't ask
  --force              Upgrade even when a plugin has no version for the new core
  --allow-dirty        Start with uncommitted changes
  --cwd <dir>          Start looking for the project here (default: current directory)
  -h, --help           Show this help
`

export interface UpgradeOptions {
  cwd: string
  to?: string
  onlyMigrations: boolean
  dryRun: boolean
  yes: boolean
  force: boolean
  allowDirty: boolean
  /** The npm registry: npm_config_registry, else registry.npmjs.org */
  registry: string
}

export interface UpgradeIO {
  run(command: string, args: string[], cwd: string): Promise<void>
  confirm(question: string): Promise<boolean>
  readonly interactive: boolean
  write(text: string): void
  /** `git status --porcelain` in `cwd`; undefined outside a git repository */
  gitStatus?(cwd: string): string | undefined
  fetch?: typeof globalThis.fetch
  color?: boolean
}

export function parseUpgradeArgs(args: string[], cwd = process.cwd(), env: Record<string, string | undefined> = process.env): UpgradeOptions | 'help' {
  const { values, positionals } = parseArgs({
    args,
    options: {
      'to': { type: 'string' },
      'only-migrations': { type: 'boolean', default: false },
      'dry-run': { type: 'boolean', default: false },
      'yes': { type: 'boolean', short: 'y', default: false },
      'force': { type: 'boolean', default: false },
      'allow-dirty': { type: 'boolean', default: false },
      'cwd': { type: 'string' },
      'help': { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  })

  if (values.help)
    return 'help'

  if (positionals.length > 0)
    throw new UsageError(`unexpected argument '${positionals[0]}'\n\n${UPGRADE_HELP}`)

  if (values.to !== undefined && !parseVersion(values.to))
    throw new UsageError(`--to takes a version like 0.0.26, not '${values.to}'`)

  if (values.to !== undefined && values['only-migrations'])
    throw new UsageError('--to and --only-migrations don\'t go together: --only-migrations leaves the packages alone')

  return {
    cwd: resolve(cwd, values.cwd ?? '.'),
    to: values.to,
    onlyMigrations: values['only-migrations'],
    dryRun: values['dry-run'],
    yes: values.yes,
    force: values.force,
    allowDirty: values['allow-dirty'],
    registry: env.npm_config_registry || NPM_REGISTRY_URL,
  }
}

function gitStatus(cwd: string): string | undefined {
  try {
    return execFileSync('git', ['status', '--porcelain'], {
      cwd,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    })
  }
  catch {
    return undefined
  }
}

function confirmOnTerminal(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return rl.question(question)
    .then(answer => ['', 'y', 'yes'].includes(answer.trim().toLowerCase()))
    .finally(() => rl.close())
}

const terminalIO: UpgradeIO = {
  run: (command, args, cwd) => runCommand(command, args, cwd, {
    report: {
      step: () => {},
      output: chunk => process.stdout.write(chunk),
    },
  }),
  confirm: confirmOnTerminal,
  get interactive() {
    return !!process.stdin.isTTY && !!process.stdout.isTTY
  },
  write: text => void process.stdout.write(text),
  gitStatus,
  color: !!process.stdout.isTTY && !process.env.NO_COLOR,
}

export function formatPlan(plan: UpgradePlan): string {
  const width = Math.max(...plan.bumps.map(bump => bump.name.length))
  const from = Math.max(...plan.bumps.map(bump => (bump.installed ?? '-').length))
  const line = (bump: Bump) => {
    const head = `  ${bump.blocked
      ? '✗'
      : bump.to ? '↑' : '·'} ${bump.name.padEnd(width)}  ${(bump.installed ?? '-').padEnd(from)}`
    if (bump.blocked)
      return `${head}  ${bump.note}`
    if (bump.to)
      return `${head}  → ${bump.to}`
    return `${head}  ${bump.note ?? 'stays'}`
  }
  return `Packages, for @mavonengine/core ${plan.core.to}\n${plan.bumps.map(line).join('\n')}\n`
}

/** Whether to go on: yes with --yes, no without a terminal to ask on */
async function ask(io: UpgradeIO, options: UpgradeOptions, question: string, action: string): Promise<boolean> {
  if (options.yes)
    return true
  if (!io.interactive) {
    io.write(`\nNothing ${action === 'install'
      ? 'installed'
      : 'written'}: there is no terminal to ask on, run with --yes to ${action}\n`)
    return false
  }
  return io.confirm(`\n${question} (Y/n) `)
}

/**
 * Upgrade the packages, migrate, then run doctor. Resolves with the exit code.
 */
export async function runUpgradeCommand(options: UpgradeOptions, io: UpgradeIO = terminalIO): Promise<number> {
  const root = findProjectRoot(options.cwd)
  if (!root)
    throw new UsageError(`no MavonEngine project found in ${options.cwd} or its parents (looking for a package.json with @mavonengine/core and a dev script)`)

  const pm = detectPackageManager(root)
  const npm = new NpmRegistry({ url: options.registry, fetch: io.fetch })
  const readPackageJson = () => JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
  io.write(`mavonengine upgrade in ${root} (${pm}${options.dryRun ? ', dry run' : ''})\n\n`)

  if (!options.dryRun && !options.allowDirty) {
    const status = (io.gitStatus ?? gitStatus)(root)
    if (status?.trim()) {
      io.write(`There are uncommitted changes:\n${status.trimEnd().split('\n').map(line => `  ${line}`).join('\n')}\n\nCommit or stash them first, so the upgrade's changes can be looked at on their own, or pass --allow-dirty\n`)
      return 1
    }
  }

  // 1. Packages
  if (!options.onlyMigrations) {
    let plan: UpgradePlan
    try {
      plan = await planUpgrade(root, readPackageJson(), npm, options.to)
    }
    catch (err) {
      if (err instanceof UpgradeError) {
        io.write(`Can't plan the upgrade: ${err.message}\n`)
        return 1
      }
      throw err
    }

    io.write(formatPlan(plan))
    const blocked = plan.bumps.filter(bump => bump.blocked)
    if (blocked.length && !options.force) {
      io.write(`\n${blocked.map(bump => bump.name).join(', ')} would stop working: no version of ${blocked.length === 1
        ? 'it'
        : 'them'} supports @mavonengine/core ${plan.core.to}. Pick an older core with --to, remove ${blocked.length === 1
        ? 'it'
        : 'them'}, or pass --force to upgrade anyway\n`)
      return 1
    }

    const commands = installCommands(pm, plan.bumps)
    if (!commands.length) {
      io.write('\nThe packages are up to date\n')
    }
    else {
      const shown = commands.map(args => `${pm} ${args.join(' ')}`).join('\n  ')
      if (options.dryRun) {
        io.write(`\nWould run:\n  ${shown}\n`)
      }
      else {
        if (!await ask(io, options, `Install them with:\n  ${shown}\n?`, 'install'))
          return 1
        for (const args of commands) {
          io.write(`\nmavonengine: running '${pm} ${args.join(' ')}'\n`)
          await io.run(pm, args, root)
        }
      }
    }
  }

  // 2. Migrations, from the core that is installed now
  const coreVersion = coreVersionOf(root)
  if (!coreVersion) {
    io.write(`\n@mavonengine/core isn't installed, so there is nothing to migrate: run '${pm} install' first\n`)
    return 1
  }

  const { module, from } = await loadMigrations(root)
  const ctx = {
    files: new module.ProjectFiles(root),
    versions: { core: coreVersion, cli: cliVersion },
  }
  const pending = module.pendingMigrations(ctx)
  const dryRunNote = options.dryRun && !options.onlyMigrations
    ? ', for the core installed now; the new core may bring more'
    : ''
  io.write(`\nMigrations, for @mavonengine/core ${coreVersion}${from === 'cli'
    ? ' (from the CLI: the installed core has none of its own)'
    : ''}${dryRunNote}\n`)

  let migrated = false
  if (!pending.length) {
    io.write('  none pending\n')
  }
  else {
    const changes = module.applyMigrations(ctx, pending)
    const width = Math.max(...pending.map(migration => migration.id.length))
    for (const migration of pending)
      io.write(`  ${migration.id.padEnd(width)}  ${migration.description}\n`)
    for (const change of changes) {
      io.write(`\n  ${change.before === undefined
        ? 'new '
        : ''}${change.path}\n`)
      io.write(`${lineDiff(change.before, change.after).map(line => `    ${line}`).join('\n')}\n`)
    }

    if (options.dryRun) {
      io.write('\nNothing written (--dry-run)\n')
      return 0
    }

    if (!await ask(io, options, `Write ${changes.length === 1
      ? 'this change'
      : `these ${changes.length} changes`}?`, 'write the changes')) {
      return 1
    }

    const before = JSON.stringify(readPackageJson())
    ctx.files.commit()
    migrated = true
    io.write(`\nmavonengine: migrated ${pending.length === 1
      ? '1 migration'
      : `${pending.length} migrations`}, recorded in ${CONFIG_FILE}\n`)

    // A migration that adds a dependency needs it installed
    if (JSON.stringify(readPackageJson()) !== before) {
      io.write(`\nmavonengine: package.json changed, running '${pm} install'\n`)
      await io.run(pm, ['install'], root)
    }
  }

  if (options.dryRun)
    return 0

  // 3. Doctor
  io.write(`\n${migrated ? 'Checking the result' : 'Checking the project'}: mavonengine doctor\n\n`)
  const report = await runDoctor(root, { offline: false, registry: options.registry }, { fetch: io.fetch })
  io.write(formatReport(report, { color: io.color }))
  return report.errors ? 1 : 0
}
