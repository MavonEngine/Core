import type { DoctorContext, Finding, Level } from '../doctor/checks'
import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { CONFIG_FILE } from '@mavonengine/core/Plugins/ProjectConfig'
import { version as cliVersion } from '../../package.json'
import { checkConfig, checkEnvironment, checkMigrations, checkPlugins, coreVersionOf, GROUPS, registryFinding } from '../doctor/checks'
import { NPM_REGISTRY_URL, NpmRegistry } from '../doctor/npm'
import { UsageError } from './dashboard'
import { detectPackageManager, findProjectRoot } from './dev'

export const DOCTOR_HELP = `Usage: mavonengine doctor [options]

Check the MavonEngine project you are in: the Node version, the @mavonengine packages,
${CONFIG_FILE}, and whether each plugin in it is installed, built and made for the
project's @mavonengine/core. Changes nothing.

Asks the npm registry which versions exist, to say what to install when something
doesn't fit. --offline leaves that out.

Exits with 1 when something is wrong, and with --strict also on warnings.

Options:
  --offline          Don't ask the npm registry
  --strict           Fail on warnings too
  --json             Print the findings as JSON
  --cwd <dir>        Start looking for the project here (default: current directory)
  -h, --help         Show this help
`

export interface DoctorOptions {
  cwd: string
  offline: boolean
  strict: boolean
  json: boolean
  /** The npm registry: npm_config_registry, else registry.npmjs.org */
  registry: string
}

export interface DoctorIO {
  fetch?: typeof globalThis.fetch
  nodeVersion?: string
  env?: Record<string, string | undefined>
  /** Colored output */
  color?: boolean
  write(text: string): void
}

export interface DoctorReport {
  root: string
  packageManager: string
  coreVersion?: string
  findings: Finding[]
  errors: number
  warnings: number
}

/**
 * Turn CLI arguments into options. Throws UsageError on bad input.
 */
export function parseDoctorArgs(args: string[], cwd = process.cwd(), env: Record<string, string | undefined> = process.env): DoctorOptions | 'help' {
  const { values, positionals } = parseArgs({
    args,
    options: {
      offline: { type: 'boolean', default: false },
      strict: { type: 'boolean', default: false },
      json: { type: 'boolean', default: false },
      cwd: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  })

  if (values.help)
    return 'help'

  if (positionals.length > 0)
    throw new UsageError(`unexpected argument '${positionals[0]}'\n\n${DOCTOR_HELP}`)

  return {
    cwd: resolve(cwd, values.cwd ?? '.'),
    offline: values.offline,
    strict: values.strict,
    json: values.json,
    registry: env.npm_config_registry || NPM_REGISTRY_URL,
  }
}

/**
 * Run every check on the project at `root`.
 */
export async function runDoctor(root: string, options: Pick<DoctorOptions, 'offline' | 'registry'>, io: Omit<DoctorIO, 'write'> = {}): Promise<DoctorReport> {
  const ctx: DoctorContext = {
    root,
    packageManager: detectPackageManager(root),
    packageJson: JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')),
    nodeVersion: io.nodeVersion ?? process.versions.node,
    npm: options.offline
      ? undefined
      : new NpmRegistry({ url: options.registry, fetch: io.fetch }),
  }

  const { findings: configFindings, config } = checkConfig(root, io.env ?? process.env)
  const [environment, plugins, migrations] = await Promise.all([
    checkEnvironment(ctx),
    config
      ? checkPlugins(ctx, config)
      : [],
    config
      ? checkMigrations(ctx, cliVersion)
      : [],
  ])
  const registry = registryFinding(ctx.npm)
  const findings = [
    ...environment,
    ...(registry
      ? [registry]
      : []),
    ...configFindings,
    ...plugins,
    ...migrations,
  ]

  return {
    root,
    packageManager: ctx.packageManager,
    coreVersion: coreVersionOf(root),
    findings,
    errors: findings.filter(finding => finding.level === 'error').length,
    warnings: findings.filter(finding => finding.level === 'warn').length,
  }
}

const MARKS: Record<Level, string> = {
  ok: '✓',
  info: 'i',
  warn: '!',
  error: '✗',
}
const COLORS: Record<Level, string> = {
  ok: '32',
  info: '36',
  warn: '33',
  error: '31',
}

export function formatReport(report: DoctorReport, { color = false }: { color?: boolean } = {}): string {
  const paint = (code: string, text: string) => color
    ? `\x1B[${code}m${text}\x1B[0m`
    : text
  const lines = [`MavonEngine project at ${report.root} (${report.packageManager}${report.coreVersion
    ? `, @mavonengine/core ${report.coreVersion}`
    : ''})`]

  for (const group of GROUPS) {
    const findings = report.findings.filter(finding => finding.group === group)
    if (!findings.length)
      continue

    const width = Math.min(40, Math.max(...findings.map(finding => finding.label.length)))
    lines.push('', paint('1', group))
    for (const finding of findings) {
      const text = finding.detail
        ? `${finding.label.padEnd(width)}  ${finding.detail}`
        : finding.label
      lines.push(`  ${paint(COLORS[finding.level], MARKS[finding.level])} ${text}`)
      if (finding.fix)
        lines.push(`      ${paint('2', `→ ${finding.fix}`)}`)
    }
  }

  const count = (n: number, word: string) => `${n} ${word}${n === 1
    ? ''
    : 's'}`
  lines.push('', report.errors || report.warnings
    ? `${count(report.errors, 'error')}, ${count(report.warnings, 'warning')}`
    : paint(COLORS.ok, 'Everything looks fine'))

  return `${lines.join('\n')}\n`
}

export async function runDoctorCommand(options: DoctorOptions, io: DoctorIO = {
  write: text => void process.stdout.write(text),
  color: !!process.stdout.isTTY && !process.env.NO_COLOR,
}): Promise<number> {
  const root = findProjectRoot(options.cwd)
  if (!root || !existsSync(join(root, 'package.json')))
    throw new UsageError(`no MavonEngine project found in ${options.cwd} or its parents (looking for a package.json with @mavonengine/core and a dev script)`)

  const report = await runDoctor(root, options, io)

  io.write(options.json
    ? `${JSON.stringify(report, null, 2)}\n`
    : formatReport(report, { color: io.color }))

  return report.errors || (options.strict && report.warnings)
    ? 1
    : 0
}
