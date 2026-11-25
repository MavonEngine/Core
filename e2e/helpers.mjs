/**
 * Shared by the end-to-end tests: running commands, booting the template's game server
 * and putting the template back the way it was afterwards.
 */
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

export const repo = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const template = join(repo, 'packages/multiplayer-template')
export const cli = join(repo, 'packages/cli/dist/index.js')
export const PORT = 8050
export const base = `http://localhost:${PORT}`
export const isWindows = process.platform === 'win32'

export const log = text => process.stdout.write(`${text}\n`)

export function check(condition, message) {
  if (!condition)
    throw new Error(`check failed: ${message}`)
  log(`  ok  ${message}`)
}

export const readJson = path => JSON.parse(readFileSync(path, 'utf8'))

export const status = async (path, init) => (await fetch(`${base}${path}`, init)).status

/** The env with `dir` first on the PATH. Windows spells the key Path, and a second PATH key would be ambiguous */
export function withPathFirst(dir) {
  const env = { ...process.env }
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[key] = `${dir}${delimiter}${env[key] ?? ''}`
  return env
}

/** Run a command to completion, printing its output, and resolve with that output */
export function run(command, args, { cwd, env = process.env }) {
  return new Promise((resolvePromise, reject) => {
    // npm is a .cmd shim on Windows
    const child = spawn(command, args, { cwd, env, shell: isWindows && command !== process.execPath })
    let output = ''
    const keep = (chunk) => {
      output += chunk
      process.stdout.write(chunk)
    }
    child.stdout.setEncoding('utf8').on('data', keep)
    child.stderr.setEncoding('utf8').on('data', keep)
    child.on('error', reject)
    child.on('exit', code => code === 0
      ? resolvePromise(output)
      : reject(new Error(`'${command} ${args.join(' ')}' exited with code ${code}`)))
  })
}

/** Start the built template server and wait until it answers the health endpoint */
export async function startServer(env) {
  const child = spawn(process.execPath, ['dist/index.js'], {
    cwd: join(template, 'server'),
    env: { ...process.env, ...env },
  })
  let output = ''
  let exited = false
  child.stdout.setEncoding('utf8').on('data', chunk => output += chunk)
  child.stderr.setEncoding('utf8').on('data', chunk => output += chunk)
  const exit = new Promise(resolvePromise => child.on('exit', () => {
    exited = true
    resolvePromise()
  }))

  const deadline = Date.now() + 30000
  while (true) {
    if (exited)
      throw new Error(`the server exited during startup:\n${output}`)
    if (Date.now() > deadline) {
      child.kill()
      throw new Error(`the server did not answer within 30s:\n${output}`)
    }
    try {
      if ((await fetch(`${base}/api/game/health`)).ok)
        break
    }
    catch {
      // Not listening yet
    }
    await delay(250)
  }

  return {
    output: () => output,
    /** Whether `text` shows up in the output within `ms`. The page can see an event before the server's log line about it comes through the pipe */
    async waitForOutput(text, ms = 10000) {
      const until = Date.now() + ms
      while (!output.includes(text) && Date.now() < until)
        await delay(100)
      return output.includes(text)
    },
    async stop() {
      if (!exited)
        child.kill()
      await exit
    },
  }
}

/** Link `target` into the template's node_modules as `name`, like npm does for a file: dependency */
export function linkIntoTemplate(name, target) {
  const link = join(template, 'node_modules', name)
  mkdirSync(dirname(link), { recursive: true })
  rmSync(link, { recursive: true, force: true })
  // Junctions need no admin rights on Windows
  symlinkSync(target, link, isWindows ? 'junction' : 'dir')
  return link
}

/**
 * Remember files in the template so they can be put back after the test, also on failure.
 * Files that didn't exist are removed again.
 */
export function snapshotFiles(paths) {
  const saved = paths.map(path => [path, existsSync(path) ? readFileSync(path) : undefined])
  return () => {
    for (const [path, content] of saved) {
      if (content === undefined)
        rmSync(path, { recursive: true, force: true })
      else
        writeFileSync(path, content)
    }
  }
}

/** How long the editor's UI may take to load: it is built from source by the dev server, next to a game that renders in software */
const EDITOR_UI_TIMEOUT = 120000

/**
 * The editor exists as soon as `.` is pressed, its UI only once the dev server has built it and React has drawn it.
 * Waits for one of its tabs. Fails with what the page reported when that doesn't happen, instead of a bare timeout
 */
export async function waitForEditorUi(page, tabName, errors, problems = []) {
  const started = Date.now()
  const tab = page.getByRole('tab', { name: tabName })

  while (true) {
    if (await tab.count() > 0)
      break
    if (errors.length)
      throw new Error(`the editor's UI did not load:\n  ${errors.join('\n  ')}`)
    if (Date.now() - started > EDITOR_UI_TIMEOUT)
      throw new Error(`the editor's UI was not there after ${EDITOR_UI_TIMEOUT / 1000}s${problems.length ? `:\n  ${problems.slice(-20).join('\n  ')}` : ', and the page reported nothing'}`)
    await delay(500)
  }

  log(`  the editor's UI took ${((Date.now() - started) / 1000).toFixed(1)}s to load`)
  return tab
}
