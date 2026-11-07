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
