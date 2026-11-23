/**
 * End-to-end test for `mavonengine doctor`, run against packages/multiplayer-template with a fake npm registry
 * (npm-registry.mjs) that knows a newer core and two versions of a fixture plugin:
 *
 * 1. the template as it is: nothing wrong, and the registry's newer core is pointed out
 * 2. a plugin made for a newer core: doctor fails, says which published version fits the template's core
 * 3. the game server loads that plugin anyway and warns about it
 * 4. with the version doctor pointed to in its place: doctor passes again
 * 5. the registry unreachable: a warning, which only --strict fails on; --offline doesn't ask it
 *
 * The fixture plugins are written to a temp directory and linked into the template's node_modules, like the
 * plugin e2e test's npm stub does, so the npm-linked @mavonengine/core stays. The template's mavonengine.json
 * is restored afterwards, also on failure.
 *
 * Needs the cli, core and the template's server built (with core npm-linked in CI).
 *
 *   node e2e/doctor/run.mjs
 */
import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import { check, cli, linkIntoTemplate, log, readJson, repo, run, snapshotFiles, startServer, template } from '../helpers.mjs'
import { closedPort, startRegistry } from './npm-registry.mjs'

const PLUGIN = 'doctor-fixture-plugin'

/** Run the CLI to completion and resolve with its exit code and output, whatever the code */
function doctor(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, 'doctor', ...args], { cwd: template, env: { ...process.env, NO_COLOR: '1', ...env } })
    let output = ''
    const keep = (chunk) => {
      output += chunk
      process.stdout.write(chunk)
    }
    child.stdout.setEncoding('utf8').on('data', keep)
    child.stderr.setEncoding('utf8').on('data', keep)
    child.on('error', reject)
    child.on('exit', code => resolve({ code, output }))
  })
}

function nextPatch(version) {
  const [major, minor, patch] = version.split('-')[0].split('.').map(Number)
  return `${major}.${minor}.${patch + 1}`
}

/** A server plugin package in `dir` */
function writePlugin(dir, version, engine) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify({
    name: PLUGIN,
    version,
    type: 'module',
    private: true,
    mavonengine: { target: 'server', server: './server.js', engine },
  }, null, 2))
  writeFileSync(join(dir, 'server.js'), `export default { name: 'Doctor fixture ${version}' }\n`)
}

const finding = (report, label) => report.findings.find(f => f.label.startsWith(label))

async function main() {
  const core = readJson(join(repo, 'packages/core/package.json')).version
  const newerCore = nextPatch(core)
  const configPath = join(template, 'mavonengine.json')
  const restore = snapshotFiles([configPath])
  const fixtures = mkdtempSync(join(tmpdir(), 'mavonengine-doctor-'))

  // 2.0.0 needs a core that isn't out yet as far as the template knows; 1.0.0 takes the template's
  writePlugin(join(fixtures, 'ahead'), '2.0.0', `>=${newerCore}`)
  writePlugin(join(fixtures, 'fits'), '1.0.0', `>=${core}`)

  const registry = await startRegistry({
    '@mavonengine/core': { latest: newerCore, versions: { [core]: {}, [newerCore]: {} } },
    [PLUGIN]: {
      latest: '2.0.0',
      versions: {
        '0.9.0': { mavonengine: { engine: '<0.0.1' } },
        '1.0.0': { mavonengine: { engine: `>=${core}` } },
        '2.0.0': { mavonengine: { engine: `>=${newerCore}` } },
      },
    },
  })
  const env = { npm_config_registry: registry.url }

  let server
  try {
    log('\n== the template as it is')
    let result = await doctor(['--json'], env)
    let report = JSON.parse(result.output)
    check(result.code === 0, 'doctor passes on the template')
    check(report.coreVersion === core, `it sees the template's @mavonengine/core ${core}`)
    check(report.errors === 0 && report.warnings === 0, 'with no errors or warnings')
    check(finding(report, '@mavonengine/core')?.detail === `${newerCore} is out`, 'and points out the registry\'s newer core')
    check(registry.requests.includes('@mavonengine/core'), 'it asked the registry from npm_config_registry')

    log('\n== a plugin made for a newer core')
    linkIntoTemplate(PLUGIN, join(fixtures, 'ahead'))
    writeFileSync(configPath, `${JSON.stringify({ plugins: { [PLUGIN]: { enabled: true } } }, null, 2)}\n`)

    result = await doctor([], env)
    check(result.code === 1, 'doctor fails')
    check(result.output.includes(`made for @mavonengine/core >=${newerCore}, the project has ${core}`), 'it says the plugin needs a newer core')
    check(result.output.includes(`→ mavonengine install ${PLUGIN}@1.0.0`), 'and which published version fits the template\'s core')
    check(result.output.includes('1 error, 0 warnings'), 'it counts one error')

    log('\n== the game server')
    await run('npm', ['run', 'build'], { cwd: join(template, 'server') })
    server = await startServer({ LOG_LEVEL: 'debug' })
    check(server.output().includes(`Plugin loaded anyway: ${PLUGIN} 2.0.0 is made for @mavonengine/core >=${newerCore}`), 'the server warns about the plugin')
    check(server.output().includes(`Plugin loaded: Doctor fixture 2.0.0 (${PLUGIN}) (server)`), 'and loads it anyway')
    await server.stop()
    server = undefined

    log('\n== with the version doctor pointed to')
    linkIntoTemplate(PLUGIN, join(fixtures, 'fits'))
    result = await doctor(['--json'], env)
    report = JSON.parse(result.output)
    check(result.code === 0, 'doctor passes again')
    check(finding(report, `${PLUGIN} 1.0.0`)?.level === 'ok', 'with the plugin fine')

    log('\n== without the registry')
    const unreachable = { npm_config_registry: `http://127.0.0.1:${await closedPort()}` }
    result = await doctor([], unreachable)
    check(result.code === 0, 'doctor still passes when the registry can\'t be reached')
    check(result.output.includes('! npm registry') && result.output.includes('0 errors, 1 warning'), 'and warns that it couldn\'t ask it')
    check((await doctor(['--strict'], unreachable)).code === 1, '--strict fails on that warning')

    const asked = registry.requests.length
    check((await doctor(['--offline'], env)).code === 0, '--offline passes')
    check(registry.requests.length === asked, 'without asking the registry')

    log('\ndoctor e2e passed')
  }
  catch (err) {
    if (server)
      process.stderr.write(`\n-- server output --\n${server.output()}\n`)
    throw err
  }
  finally {
    await server?.stop()
    await registry.close()
    restore()
    rmSync(join(template, 'node_modules', PLUGIN), { recursive: true, force: true })
    rmSync(fixtures, { recursive: true, force: true })
  }
}

main().catch((err) => {
  process.stderr.write(`\ndoctor e2e failed: ${err.stack ?? err}\n`)
  process.exit(1)
})
