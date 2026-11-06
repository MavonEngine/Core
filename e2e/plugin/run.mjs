/**
 * End-to-end test for engine plugins, run against packages/multiplayer-template:
 *
 * 1. `mavonengine install file:e2e/plugin/hello-plugin --yes` registers it in mavonengine.json
 * 2. dev server: the server plugin loads and answers its route, every plugin asset is served,
 *    the client virtual module lists the plugin, and placing a prefab records it in mavonengine.json
 * 3. `mavonengine build`: the release has the shared asset and the used prefab's, not the unused one's
 * 4. production server: serves what was shipped, 404s what was left out, still runs the plugin
 *
 * Needs the cli and core built and the template's dependencies installed (with core npm-linked in CI).
 * The template's package.json and mavonengine.json are restored afterwards, also on failure.
 *
 *   node e2e/plugin/run.mjs
 */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, dirname, join, resolve } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '../..')
const template = join(repo, 'packages/multiplayer-template')
const cli = join(repo, 'packages/cli/dist/index.js')
const fixture = join(here, 'hello-plugin')
const PLUGIN = 'hello-plugin'
const PORT = 8050
const base = `http://localhost:${PORT}`
const isWindows = process.platform === 'win32'

const log = text => process.stdout.write(`${text}\n`)

function check(condition, message) {
  if (!condition)
    throw new Error(`check failed: ${message}`)
  log(`  ok  ${message}`)
}

/** The env with `dir` first on the PATH. Windows spells the key Path, and a second PATH key would be ambiguous */
function withPathFirst(dir) {
  const env = { ...process.env }
  const key = Object.keys(env).find(k => k.toUpperCase() === 'PATH') ?? 'PATH'
  env[key] = `${dir}${delimiter}${env[key] ?? ''}`
  return env
}

/** Run a command to completion, printing its output, and resolve with that output */
function run(command, args, { cwd, env = process.env }) {
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
async function startServer(env) {
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

const readJson = path => JSON.parse(readFileSync(path, 'utf8'))
const status = async path => (await fetch(`${base}${path}`)).status

async function main() {
  const packageJsonPath = join(template, 'package.json')
  const configPath = join(template, 'mavonengine.json')
  const releasePlugin = join(template, 'client/dist/plugins', PLUGIN)
  const originalPackageJson = readFileSync(packageJsonPath, 'utf8')
  const originalConfig = existsSync(configPath) ? readFileSync(configPath, 'utf8') : undefined

  // A fake npm first on the PATH for the install step, see npm-stub.mjs
  const bin = mkdtempSync(join(tmpdir(), 'mavonengine-npm-stub-'))
  const stub = join(here, 'npm-stub.mjs')
  if (isWindows) {
    writeFileSync(join(bin, 'npm.cmd'), `@"${process.execPath}" "${stub}" %*\r\n`)
  }
  else {
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${stub}" "$@"\n`)
    chmodSync(join(bin, 'npm'), 0o755)
  }

  let server
  try {
    log('\n== mavonengine install')
    const installOutput = await run(process.execPath, [cli, 'install', `file:${fixture}`, '--yes'], { cwd: template, env: withPathFirst(bin) })
    check(installOutput.includes(`${PLUGIN}@0.1.0 is a MavonEngine plugin (client + server)`), 'install recognizes the plugin')
    check(readJson(configPath).plugins[PLUGIN]?.enabled === true, `install adds ${PLUGIN} to mavonengine.json`)

    log('\n== dev server')
    await run('npm', ['run', 'build'], { cwd: join(template, 'server') })
    server = await startServer({ MAVONENGINE_DEV_CLIENT: '1', LOG_LEVEL: 'debug' })
    check(server.output().includes(`Plugin loaded: Hello (${PLUGIN}) (server)`), 'the server loads the plugin')
    const hello = await (await fetch(`${base}/api/hello`)).json()
    check(hello.hello === 'world', 'the plugin\'s HTTP route answers')
    await delay(500)
    check((await (await fetch(`${base}/api/hello`)).json()).ticks > hello.ticks, 'the plugin ticks with the server')
    check(await status(`/plugins/${PLUGIN}/models/rock.gltf`) === 200, 'dev serves assets of unused prefabs too')
    const virtualModule = await (await fetch(`${base}/@id/__x00__virtual:mavonengine/plugins`)).text()
    check(virtualModule.includes(`package: "${PLUGIN}"`), 'the client virtual module lists the plugin')
    const recorded = await fetch(`${base}/__mavonengine/prefab-used`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ plugin: PLUGIN, prefab: 'Tree' }),
    })
    check((await recorded.json()).recorded === true, 'placing a prefab is recorded')
    check(JSON.stringify(readJson(configPath).plugins[PLUGIN].prefabs) === '["Tree"]', 'mavonengine.json lists the used prefab')
    await server.stop()
    server = undefined

    log('\n== mavonengine build')
    const buildOutput = await run(process.execPath, [cli, 'build'], { cwd: template })
    check(buildOutput.includes(`${PLUGIN}: 2 assets, prefabs: Tree`), 'build summarizes the shipped plugin assets')
    check(existsSync(join(releasePlugin, 'textures/shared.txt')), 'the release has the shared asset')
    check(existsSync(join(releasePlugin, 'models/tree.gltf')), 'the release has the used prefab\'s asset')
    check(!existsSync(join(releasePlugin, 'models/rock.gltf')), 'the release leaves out the unused prefab\'s asset')

    log('\n== production server')
    server = await startServer({ NODE_ENV: 'production' })
    check(await status(`/plugins/${PLUGIN}/models/tree.gltf`) === 200, 'production serves the shipped asset')
    check(await status(`/plugins/${PLUGIN}/models/rock.gltf`) === 404, 'production 404s the left out asset')
    check((await (await fetch(`${base}/api/hello`)).json()).hello === 'world', 'the plugin runs in production')

    log('\nplugin e2e passed')
  }
  catch (err) {
    if (server)
      process.stderr.write(`\n-- server output --\n${server.output()}\n`)
    throw err
  }
  finally {
    await server?.stop()
    writeFileSync(packageJsonPath, originalPackageJson)
    if (originalConfig === undefined)
      rmSync(configPath, { force: true })
    else
      writeFileSync(configPath, originalConfig)
    rmSync(join(template, 'node_modules', PLUGIN), { recursive: true, force: true })
    rmSync(releasePlugin, { recursive: true, force: true })
    rmSync(bin, { recursive: true, force: true })
  }
}

main().catch((err) => {
  process.stderr.write(`\nplugin e2e failed: ${err.stack ?? err}\n`)
  process.exit(1)
})
