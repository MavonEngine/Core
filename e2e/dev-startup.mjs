/**
 * CI smoke test for `npm run dev` in packages/multiplayer-template: starts it, waits until the game server answers
 * the health endpoint, then stops the whole process tree. Exits non-zero when the server doesn't come up in time.
 *
 * Nothing is installed on the fly (unlike `npx concurrently` / `npx wait-on`, which were slow enough on Windows
 * runners to eat the step's time limit).
 *
 *   node e2e/dev-startup.mjs
 */
import { spawn, spawnSync } from 'node:child_process'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { base, isWindows, log, template } from './helpers.mjs'

const TIMEOUT_MS = 60000

// npm is a .cmd shim on Windows. detached gives the tree its own process group on POSIX so it can be killed as one
const child = spawn('npm', ['run', 'dev'], {
  cwd: template,
  shell: isWindows,
  detached: !isWindows,
  stdio: 'inherit',
})

let exitCode
const exited = new Promise(resolvePromise => child.on('exit', (code) => {
  exitCode = code
  resolvePromise()
}))

/** npm, tsup, the server and Vite are all separate processes: kill every one of them */
function killTree() {
  if (exitCode !== undefined)
    return
  if (isWindows) {
    spawnSync('taskkill', [
      '/pid',
      String(child.pid),
      '/T',
      '/F',
    ], { stdio: 'ignore' })
  }
  else {
    process.kill(-child.pid, 'SIGTERM')
  }
}

async function waitForHealth() {
  const deadline = Date.now() + TIMEOUT_MS
  while (Date.now() < deadline) {
    if (exitCode !== undefined)
      throw new Error(`'npm run dev' exited with code ${exitCode} before the server answered`)
    try {
      if ((await fetch(`${base}/api/game/health`)).ok)
        return
    }
    catch {
      // Not listening yet
    }
    await delay(500)
  }
  throw new Error(`the server did not answer ${base}/api/game/health within ${TIMEOUT_MS / 1000}s`)
}

async function main() {
  try {
    await waitForHealth()
    log(`\ndev-startup: ${base}/api/game/health answered, stopping the dev servers`)
  }
  finally {
    killTree()
    await Promise.race([
      exited,
      delay(10000),
    ])
  }
}

main().catch((error) => {
  log(`\ndev-startup: ${error.message}`)
  process.exitCode = 1
})
