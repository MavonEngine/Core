import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { constants } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'

/** @mavonengine/cli needs this Node major or newer */
export const MIN_NODE_MAJOR = 24

const VERSION_PREFIX_RE = /^v/

export const DEPRECATION_NOTICE = 'create-bootstrap is deprecated, use \'npx @mavonengine/cli create\' instead\n'

export function isSupportedNode(version: string): boolean {
  return Number(version.replace(VERSION_PREFIX_RE, '').split('.')[0]) >= MIN_NODE_MAJOR
}

/**
 * Path of the `mavonengine` bin of the installed @mavonengine/cli.
 */
export function cliBinPath(from: string = import.meta.url): string {
  const pkgPath = createRequire(from).resolve('@mavonengine/cli/package.json')
  const { bin } = JSON.parse(readFileSync(pkgPath, 'utf8'))
  return join(dirname(pkgPath), typeof bin === 'string' ? bin : bin.mavonengine)
}

/**
 * Run `mavonengine create` with these arguments on this terminal, so it can show its dashboard.
 * Resolves with its exit code.
 */
export function runCreate(args: string[]): Promise<number> {
  const child = spawn(process.execPath, [cliBinPath(), 'create', ...args], { stdio: 'inherit' })

  // Ctrl-C reaches the cli through the terminal's process group, so wait for it to exit.
  // Signals sent to us alone (kill, closing the terminal) are passed on.
  const onInterrupt = () => {}
  const forward = (signal: NodeJS.Signals) => child.kill(signal)
  process.on('SIGINT', onInterrupt)
  process.on('SIGTERM', forward)
  process.on('SIGHUP', forward)

  return new Promise((resolve, reject) => {
    const cleanup = () => {
      process.off('SIGINT', onInterrupt)
      process.off('SIGTERM', forward)
      process.off('SIGHUP', forward)
    }

    child.on('error', (err) => {
      cleanup()
      reject(err)
    })

    child.on('exit', (code, signal) => {
      cleanup()
      resolve(code ?? 128 + (signal ? constants.signals[signal] : 0))
    })
  })
}
