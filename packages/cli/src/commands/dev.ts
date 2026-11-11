import type { DashboardOptions } from './dashboard'
import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { parseArgs } from 'node:util'
import { canOpenBrowserHere } from '../browser'
import { startDevControl } from '../dev/control'
import PluginInstaller from '../dev/installer'
import { parseDashboardArgs, runDashboard, UsageError } from './dashboard'

export const DEV_HELP = `Usage: mavonengine dev [options]

Run the dev servers of the MavonEngine project you are in (game server and client)
and show the dashboard for it. Once the game server is up, the game opens in the
browser. Quitting the dashboard stops the dev servers.

Runs the project's 'dev:server' script, or its 'dev' script when there is none.
So 'dev' can be 'mavonengine dev' itself, as in the multiplayer template.

Options:
  --cwd <dir>        Start looking for the project here (default: current directory)
  --no-dashboard     Only run the dev script, with its output in the terminal
  --port <port>      Game server HTTP port for the dashboard (default: 8050)
  --theme <name>     Dashboard theme, see 'mavonengine dashboard --help'
  --transparent      Let a transparent terminal background show through
  --no-open          Don't open the game in the browser once the server is up
  -h, --help         Show this help
`

export interface DevOptions {
  cwd: string
  /** false with --no-dashboard */
  dashboard: DashboardOptions | false
}

/** Bytes of dev script output kept while the dashboard is up, printed if the script exits on its own */
const MAX_CAPTURED_OUTPUT = 64 * 1024

/** How long the dev processes get to exit after SIGTERM before they are killed */
const STOP_TIMEOUT_MS = 3000
/** How long killed processes get to disappear before stop() gives up waiting */
const KILL_TIMEOUT_MS = 2000

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

const WHITESPACE_RE = /\s+/
const RUNS_MAVONENGINE_DEV_RE = /\bmavonengine\s+dev\b/

/** Set for the dev script, so a `mavonengine dev` started by it notices it would start itself again */
export const DEV_ENV_FLAG = 'MAVONENGINE_DEV_SCRIPT'

/** Runs the dev servers when present, so `dev` itself can be `mavonengine dev` */
export const DEV_SERVER_SCRIPT = 'dev:server'

/** Flags shared by `mavonengine dev` and `mavonengine create` */
export const DEV_FLAGS = {
  cwd: { type: 'string' },
  dashboard: { type: 'boolean', default: true },
  port: { type: 'string' },
  theme: { type: 'string' },
  transparent: { type: 'boolean', default: false },
  open: { type: 'boolean', default: true },
  help: { type: 'boolean', short: 'h', default: false },
} as const

type DevFlags = ReturnType<typeof parseArgs<{ options: typeof DEV_FLAGS }>>['values']

/**
 * Turn CLI arguments into dev options. Throws UsageError on bad input.
 */
export function parseDevArgs(args: string[], cwd = process.cwd(), env: Record<string, string | undefined> = process.env): DevOptions | 'help' {
  const { values } = parseArgs({
    args,
    options: DEV_FLAGS,
    strict: true,
    allowPositionals: false,
    allowNegative: true,
  })

  if (values.help)
    return 'help'

  return toDevOptions(values, cwd, env)
}

export function toDevOptions(values: DevFlags, cwd: string, env: Record<string, string | undefined>): DevOptions {
  let dashboard: DashboardOptions | false = false
  if (values.dashboard) {
    const dashboardArgs = [
      ...(values.port ? ['--port', values.port] : []),
      ...(values.theme ? ['--theme', values.theme] : []),
      ...(values.transparent ? ['--transparent'] : []),
    ]
    dashboard = parseDashboardArgs(dashboardArgs, env) as DashboardOptions
    // Over SSH the browser would open on the other machine
    dashboard.openBrowser = values.open && canOpenBrowserHere(env)
  }

  return { cwd: resolve(cwd, values.cwd ?? '.'), dashboard }
}

function readPackageJson(dir: string): Record<string, any> | undefined {
  const path = join(dir, 'package.json')
  if (!existsSync(path))
    return undefined

  try {
    return JSON.parse(readFileSync(path, 'utf8'))
  }
  catch {
    return undefined
  }
}

/**
 * The script that starts the dev servers: `dev:server` when the project has one, otherwise `dev`
 */
export function devScriptOf(pkg: Record<string, any> | undefined): string | undefined {
  const scripts = pkg?.scripts ?? {}
  if (typeof scripts[DEV_SERVER_SCRIPT] === 'string')
    return DEV_SERVER_SCRIPT
  return typeof scripts.dev === 'string' ? 'dev' : undefined
}

/**
 * Throws when running `script` would start `mavonengine dev` again
 */
export function checkDevScript(root: string, env: Record<string, string | undefined> = process.env): string {
  const pkg = readPackageJson(root)
  const script = devScriptOf(pkg)
  if (!script)
    throw new UsageError(`${join(root, 'package.json')} has no '${DEV_SERVER_SCRIPT}' or 'dev' script`)

  const command = String(pkg?.scripts?.[script] ?? '')
  if (env[DEV_ENV_FLAG] || RUNS_MAVONENGINE_DEV_RE.test(command)) {
    throw new UsageError(`the '${script}' script starts 'mavonengine dev' again. Put the command that starts the game server `
      + `in a '${DEV_SERVER_SCRIPT}' script: 'mavonengine dev' runs that instead of 'dev'`)
  }

  return script
}

/**
 * Walk up from `start` to the nearest package.json that depends on @mavonengine/core and has a dev script.
 * Starting inside a workspace such as `client/` finds the project root above it.
 */
export function findProjectRoot(start: string): string | undefined {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const pkg = readPackageJson(dir)
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
    if ('@mavonengine/core' in deps && devScriptOf(pkg))
      return dir

    if (dirname(dir) === dir)
      return undefined
  }
}

/**
 * The @mavonengine/core version installed in a project, if any.
 */
export function installedEngineVersion(root: string): string | undefined {
  return readPackageJson(join(root, 'node_modules', '@mavonengine', 'core'))?.version
}

export function detectPackageManager(root: string): PackageManager {
  return LOCKFILES.find(([file]) => existsSync(join(root, file)))?.[1] ?? 'npm'
}

/**
 * Find every process below `root`, given `ps -A -o pid=,ppid=` output.
 */
export function descendants(root: number, psOutput: string): number[] {
  const children = new Map<number, number[]>()
  for (const line of psOutput.trim().split('\n')) {
    const [pid, ppid] = line.trim().split(WHITESPACE_RE).map(Number)
    if (!children.has(ppid))
      children.set(ppid, [])
    children.get(ppid)!.push(pid)
  }

  const found: number[] = []
  const queue = [root]
  while (queue.length) {
    for (const child of children.get(queue.shift()!) ?? []) {
      found.push(child)
      queue.push(child)
    }
  }
  return found
}

/**
 * A process and everything it started, parents first. Empty on Windows, where taskkill walks the tree itself.
 */
function processTree(pid: number): number[] {
  if (process.platform === 'win32')
    return []

  try {
    return [pid, ...descendants(pid, execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }))]
  }
  catch {
    return [pid]
  }
}

function signalAll(pids: number[], signal: NodeJS.Signals) {
  for (const p of pids) {
    try {
      process.kill(p, signal)
    }
    catch {
      // Already gone
    }
  }
}

function isAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  }
  catch {
    return false
  }
}

async function waitForExit(pids: number[], timeoutMs: number) {
  const deadline = Date.now() + timeoutMs
  while (pids.some(isAlive) && Date.now() < deadline)
    await delay(50)
}

/**
 * Signal a process and everything it started. npm exits on SIGTERM without passing it on,
 * which would leave the game server and vite running.
 */
function killTree(pid: number, signal: NodeJS.Signals) {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
    }
    catch {
      // Already gone
    }
    return
  }

  signalAll(processTree(pid), signal)
}

export interface DevProcess {
  /** Resolves with the dev script's exit code */
  exited: Promise<number>
  /** SIGTERM the whole tree, SIGKILL whatever is left after STOP_TIMEOUT_MS, and wait for the script to exit */
  stop(): Promise<number>
  /** The captured output, when started with `capture` */
  output(): string
}

export interface StartDevOptions {
  /** Keep the output in memory instead of writing it to the terminal, which belongs to the dashboard then */
  capture?: boolean
  /** Added to the environment of the dev script */
  env?: Record<string, string>
}

/**
 * Start the project's dev script. With `capture` its output is kept in memory instead of
 * written to the terminal, which belongs to the dashboard then.
 */
export function startDev(root: string, { capture = false, env = {} }: StartDevOptions = {}): DevProcess {
  const pm = detectPackageManager(root)
  const script = checkDevScript(root)

  const child = spawn(pm, ['run', script], {
    cwd: root,
    env: { ...process.env, ...env, [DEV_ENV_FLAG]: '1' },
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    // npm, pnpm and yarn are .cmd shims on Windows
    shell: process.platform === 'win32',
  })

  let output = ''
  const keep = (chunk: string) => {
    output = (output + chunk).slice(-MAX_CAPTURED_OUTPUT)
  }

  // The terminal may already belong to the dashboard
  const announce = `mavonengine: running '${pm} run ${script}' in ${root}\n`
  if (capture)
    keep(announce)
  else
    process.stdout.write(announce)
  child.stdout?.setEncoding('utf8').on('data', keep)
  child.stderr?.setEncoding('utf8').on('data', keep)

  let running = true

  // Ctrl-C reaches the child through the terminal's process group, so only keep ourselves alive until it exits.
  // Signals sent to us alone (kill, closing the terminal) are passed on.
  const onInterrupt = () => {}
  const forward = (signal: NodeJS.Signals) => child.pid && killTree(child.pid, signal)
  // Last resort when we exit before the dev script, e.g. the dashboard's own signal handlers calling process.exit
  const onExit = () => running && child.pid && killTree(child.pid, 'SIGTERM')
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', forward)
  process.on('SIGHUP', forward)
  process.on('exit', onExit)

  const exited = new Promise<number>((resolvePromise, reject) => {
    const cleanup = () => {
      running = false
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', forward)
      process.off('SIGHUP', forward)
      process.off('exit', onExit)
    }

    child.on('error', (err: NodeJS.ErrnoException) => {
      cleanup()
      reject(err.code === 'ENOENT' ? new Error(`'${pm}' was not found on your PATH`) : err)
    })

    child.on('exit', (code, signal) => {
      cleanup()
      resolvePromise(code ?? 128 + (signal ? constants.signals[signal] : 0))
    })
  })

  const stop = async () => {
    if (running && child.pid) {
      if (process.platform === 'win32') {
        killTree(child.pid, 'SIGTERM')
      }
      else {
        // Remembered up front: once npm exits, its children are reparented and can't be found from it anymore
        const tree = processTree(child.pid)
        signalAll(tree, 'SIGTERM')
        await waitForExit(tree, STOP_TIMEOUT_MS)

        // SIGKILL takes effect asynchronously, so wait for those to be gone too
        signalAll(tree.filter(isAlive), 'SIGKILL')
        await waitForExit(tree, KILL_TIMEOUT_MS)
      }
    }

    return exited
  }

  return { exited, stop, output: () => output }
}

export interface DevSession {
  /** Resolves with the dev script's exit code once it exits on its own, not when it is restarted */
  exited: Promise<number>
  /** Stop the dev script and start it again */
  restart(): Promise<void>
  stop(): Promise<number>
  /** The captured output of the running dev script, when started with `capture` */
  output(): string
}

/**
 * The project's dev script as something that can be restarted: `startDev()`, again and again
 */
export function startDevSession(root: string, options: StartDevOptions = {}): DevSession {
  let dev = startDev(root, options)
  let restarting = false

  let settle!: { resolve(code: number): void, reject(err: Error): void }
  const exited = new Promise<number>((resolve, reject) => settle = { resolve, reject })

  const watch = (current: DevProcess) => {
    current.exited.then((code) => {
      // Stopped by a restart: the session goes on
      if (current === dev && !restarting)
        settle.resolve(code)
    }, (err: Error) => settle.reject(err))
  }
  watch(dev)

  return {
    exited,
    output: () => dev.output(),
    stop: () => dev.stop(),
    async restart() {
      restarting = true
      try {
        await dev.stop().catch(() => {})
        dev = startDev(root, options)
      }
      finally {
        restarting = false
      }
      watch(dev)
    },
  }
}

/**
 * The dev script with what lets the editor and the dashboard install packages while it runs: an installer
 * that restarts the script afterwards, and the control server the dev servers reach it through.
 */
export async function startDevWithInstaller(root: string, { capture = false, onOutput }: { capture?: boolean, onOutput?(text: string): void } = {}) {
  // The session needs the control server's address for the dev script, the installer needs the session to restart
  let session: DevSession | undefined
  const installer = new PluginInstaller({ root, restart: async () => session?.restart() })
  const control = await startDevControl(installer)

  let written = 0
  installer.onChange((job) => {
    // Only what is new since the last change. An output cut off at the front can't be told apart, so it starts over
    onOutput?.(job.output.slice(written <= job.output.length ? written : 0))
    written = job.output.length
    if (job.status === 'done' || job.status === 'failed')
      written = 0
  })

  try {
    session = startDevSession(root, { capture, env: control.env })
  }
  catch (err) {
    await control.close()
    throw err
  }

  return { session, installer, close: () => control.close() }
}

/**
 * Run the project's dev script and resolve with its exit code. The editor can install packages while it runs.
 */
export async function runDev(root: string): Promise<number> {
  const { session, close } = await startDevWithInstaller(root, { onOutput: text => process.stdout.write(text) })

  try {
    return await session.exited
  }
  finally {
    await close()
  }
}

/**
 * Run the dev script behind the dashboard. Quitting the dashboard stops the dev script;
 * the dev script exiting on its own closes the dashboard and prints what it wrote.
 */
export async function runDevWithDashboard(root: string, dashboard: DashboardOptions): Promise<number> {
  const { session: dev, installer, close } = await startDevWithInstaller(root, { capture: true })
  const engineVersion = installedEngineVersion(root)
  const startup = () => ({ engineVersion, output: dev.output() })

  const devExited = new AbortController()
  dev.exited.then(() => devExited.abort(), () => devExited.abort())

  let quit = false
  try {
    await runDashboard({ ...dashboard, startup, installer }, devExited.signal)
  }
  finally {
    quit = !devExited.signal.aborted
    // An install that is still restarting the dev script would start it again behind our back
    await installer.finished
    if (quit)
      await dev.stop().catch(() => {})
    await close()
  }

  // The user quit, so stopping the dev servers is the expected outcome
  if (quit)
    return 0

  // Rejects when the package manager could not be started
  const exitCode = await dev.exited
  process.stderr.write(`${dev.output()}\nmavonengine: the dev script exited with code ${exitCode}\n`)
  return exitCode
}

export async function runDevCommand(options: DevOptions): Promise<number> {
  const root = findProjectRoot(options.cwd)
  if (!root)
    throw new UsageError(`no MavonEngine project found in ${options.cwd} or its parents (looking for a package.json with @mavonengine/core and a dev script)`)

  // Before the dashboard takes the terminal, so the message is readable
  checkDevScript(root)

  // The dashboard needs an interactive terminal; without one (CI, piped output) just run the dev script
  if (options.dashboard && process.stdout.isTTY && process.stdin.isTTY)
    return runDevWithDashboard(root, options.dashboard)

  return runDev(root)
}
