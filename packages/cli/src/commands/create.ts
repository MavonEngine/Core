import type { CreateReporter } from '../create/project'
import type { MetricsSource } from '../dashboard/MetricsClient'
import type { DashboardOptions } from './dashboard'
import type { DevOptions, DevProcess } from './dev'
import { existsSync } from 'node:fs'
import process from 'node:process'
import { createInterface } from 'node:readline/promises'
import { parseArgs } from 'node:util'
import { createProject, PROJECT_NAME_RE, projectDirFor } from '../create/project'
import { MetricsSourceError } from '../dashboard/MetricsClient'
import { runDashboard, UsageError } from './dashboard'
import { DEV_FLAGS, installedEngineVersion, runDev, startDev, toDevOptions } from './dev'

export const CREATE_HELP = `Usage: mavonengine create [name] [options]

Create a MavonEngine project from the multiplayer template, install its
dependencies and start it like 'mavonengine dev'. Asks for a name if none is given.

Options:
  --cwd <dir>        Create the project in here (default: current directory)
  --no-dashboard     Print the progress and the dev script's output instead
  --port <port>      Game server HTTP port for the dashboard (default: 8050)
  --theme <name>     Dashboard theme, see 'mavonengine dashboard --help'
  --transparent      Let a transparent terminal background show through
  -h, --help         Show this help
`

export interface CreateCommandOptions extends DevOptions {
  /** Asked for when missing */
  projectName?: string
}

/** Bytes of setup output kept for the startup screen, printed if setup fails */
const MAX_SETUP_OUTPUT = 64 * 1024

/**
 * Turn CLI arguments into create options. Throws UsageError on bad input.
 */
export function parseCreateArgs(args: string[], cwd = process.cwd(), env: Record<string, string | undefined> = process.env): CreateCommandOptions | 'help' {
  const { values, positionals } = parseArgs({
    args,
    options: DEV_FLAGS,
    strict: true,
    allowPositionals: true,
    allowNegative: true,
  })

  if (values.help)
    return 'help'

  if (positionals.length > 1)
    throw new UsageError(`expected one project name, got ${positionals.length}`)

  const projectName = positionals[0]?.trim() || undefined
  if (projectName)
    checkProjectName(projectName)

  return { ...toDevOptions(values, cwd, env), projectName }
}

function checkProjectName(name: string) {
  if (!PROJECT_NAME_RE.test(name))
    throw new UsageError(`invalid project name '${name}'`)
}

async function promptProjectName(): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  try {
    return (await rl.question('Project name: ')).trim()
  }
  finally {
    rl.close()
  }
}

/**
 * A metrics source that reports 'connecting' until `ready()`, so the startup screen stays up
 * while the project is set up, even if something else already answers on the port.
 */
export function gatedSource(source: MetricsSource, ready: () => boolean): MetricsSource {
  return {
    ...source,
    fetch: () => ready() ? source.fetch() : Promise.reject(new MetricsSourceError('Creating the project', 'connecting')),
  }
}

/**
 * Create the project on the startup screen, then run its dev script behind the dashboard.
 * Quitting stops whatever is running. A failed step closes the dashboard and prints the output.
 */
export async function runCreateWithDashboard(projectName: string, parentDir: string, dashboard: DashboardOptions): Promise<number> {
  let label = 'Creating the project…'
  let output = ''
  let engineVersion: string | undefined
  let dev: DevProcess | undefined

  const report: CreateReporter = {
    step: (text) => {
      label = text
    },
    output: (chunk) => {
      output = (output + chunk).slice(-MAX_SETUP_OUTPUT)
    },
  }

  // Aborted by the user quitting, stops the download or install
  const setup = new AbortController()
  // Aborted when setup fails or the dev script exits, closes the dashboard
  const done = new AbortController()

  const work = (async () => {
    const dir = await createProject({ projectName, parentDir, report, signal: setup.signal })
    setup.signal.throwIfAborted()

    engineVersion = installedEngineVersion(dir)
    label = 'Starting the game server…'
    dev = startDev(dir, { capture: true })
    return dev.exited
  })()
  work.then(() => done.abort(), () => done.abort())

  const startup = () => dev
    ? { engineVersion, output: dev.output() }
    : { engineVersion, label, output, outputTitle: 'Setup' }

  let quit = false
  try {
    await runDashboard({ ...dashboard, source: gatedSource(dashboard.source, () => dev !== undefined), startup }, done.signal)
  }
  finally {
    quit = !done.signal.aborted
    if (quit) {
      setup.abort()
      await dev?.stop().catch(() => {})
    }
  }

  if (quit) {
    if (dev)
      return 0

    await work.catch(() => {})
    process.stderr.write(`mavonengine: stopped creating the project, what was set up so far is in ${projectDirFor(projectName, parentDir)}\n`)
    return 130
  }

  try {
    const exitCode = await work
    process.stderr.write(`${dev!.output()}\nmavonengine: the dev script exited with code ${exitCode}\n`)
    return exitCode
  }
  catch (err) {
    // Rejects when setup failed or the package manager could not be started
    process.stderr.write(output)
    throw err
  }
}

/**
 * Create the project with progress in the terminal, then run its dev script there.
 */
async function runCreatePlain(projectName: string, parentDir: string): Promise<number> {
  const report: CreateReporter = {
    step: () => {},
    output: chunk => process.stdout.write(chunk),
  }

  const dir = await createProject({ projectName, parentDir, report })
  process.stdout.write(`\nmavonengine: your project is ready at ${dir}\n`)
  return runDev(dir)
}

export async function runCreateCommand(options: CreateCommandOptions): Promise<number> {
  const interactive = !!process.stdout.isTTY && !!process.stdin.isTTY

  let projectName = options.projectName
  if (!projectName) {
    if (!interactive)
      throw new UsageError('a project name is required, e.g. mavonengine create my-game')

    projectName = await promptProjectName()
    if (!projectName)
      throw new UsageError('a project name is required')
    checkProjectName(projectName)
  }

  // Checked again by createProject, but failing here doesn't flash the dashboard
  const dir = projectDirFor(projectName, options.cwd)
  if (existsSync(dir))
    throw new UsageError(`${dir} already exists`)

  // The dashboard needs an interactive terminal; without one (CI, piped output) progress goes to the terminal
  if (options.dashboard && interactive)
    return runCreateWithDashboard(projectName, options.cwd, options.dashboard)

  return runCreatePlain(projectName, options.cwd)
}
