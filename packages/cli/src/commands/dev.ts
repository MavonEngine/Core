import { execFileSync, spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { constants } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { UsageError } from './dashboard'

export const DEV_HELP = `Usage: mavonengine dev [options]

Run the dev script of the MavonEngine project you are in (game server and client).

Options:
  --cwd <dir>    Start looking for the project here (default: current directory)
  -h, --help     Show this help
`

export interface DevOptions {
  cwd: string
}

export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun'

const LOCKFILES: [string, PackageManager][] = [
  ['pnpm-lock.yaml', 'pnpm'],
  ['yarn.lock', 'yarn'],
  ['bun.lock', 'bun'],
  ['bun.lockb', 'bun'],
  ['package-lock.json', 'npm'],
]

const WHITESPACE_RE = /\s+/

/**
 * Turn CLI arguments into dev options. Throws UsageError on bad input.
 */
export function parseDevArgs(args: string[], cwd = process.cwd()): DevOptions | 'help' {
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
 * Walk up from `start` to the nearest package.json that depends on @mavonengine/core and has a dev script.
 * Starting inside a workspace such as `client/` finds the project root above it.
 */
export function findProjectRoot(start: string): string | undefined {
  for (let dir = resolve(start); ; dir = dirname(dir)) {
    const pkg = readPackageJson(dir)
    const deps = { ...pkg?.dependencies, ...pkg?.devDependencies }
    if ('@mavonengine/core' in deps && typeof pkg?.scripts?.dev === 'string')
      return dir

    if (dirname(dir) === dir)
      return undefined
  }
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
 * Signal a process and everything it started. npm exits on SIGTERM without passing it on,
 * which would leave the game server and vite running.
 */
function killTree(pid: number, signal: NodeJS.Signals) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore' })
      return
    }

    const tree = [pid, ...descendants(pid, execFileSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' }))]
    for (const p of tree) {
      try {
        process.kill(p, signal)
      }
      catch {
        // Already gone
      }
    }
  }
  catch {
    process.kill(pid, signal)
  }
}

/**
 * Run the project's dev script and resolve with its exit code.
 */
export function runDev(root: string): Promise<number> {
  const pm = detectPackageManager(root)
  process.stdout.write(`mavonengine: running '${pm} run dev' in ${root}\n`)

  const child = spawn(pm, ['run', 'dev'], {
    cwd: root,
    stdio: 'inherit',
    // npm, pnpm and yarn are .cmd shims on Windows
    shell: process.platform === 'win32',
  })

  // Ctrl-C reaches the child through the terminal's process group, so only keep ourselves alive until it exits.
  // Signals sent to us alone (kill, closing the terminal) are passed on.
  const onInterrupt = () => {}
  const forward = (signal: NodeJS.Signals) => child.pid && killTree(child.pid, signal)
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', forward)
  process.on('SIGHUP', forward)

  return new Promise((resolvePromise, reject) => {
    const cleanup = () => {
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', forward)
      process.off('SIGHUP', forward)
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
}

export async function runDevCommand(options: DevOptions): Promise<number> {
  const root = findProjectRoot(options.cwd)
  if (!root)
    throw new UsageError(`no MavonEngine project found in ${options.cwd} or its parents (looking for a package.json with @mavonengine/core and a dev script)`)

  return runDev(root)
}
