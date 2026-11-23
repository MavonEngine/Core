/**
 * End-to-end test for `mavonengine upgrade`, run against packages/multiplayer-template turned back into a project
 * from before core 0.0.22: `dev` runs the game server itself, no @mavonengine/cli, a fixed page title. The fake npm
 * registry of the doctor test (../doctor/npm-registry.mjs) has a newer core, cli and editor, and npm is a recorder
 * (npm-recorder.mjs) first on the PATH.
 *
 * 1. doctor lists both migrations as pending
 * 2. --dry-run shows the new versions and the diffs, and changes nothing
 * 3. --yes installs the new versions with npm, writes the migrations, records them and runs `npm install` for the
 *    @mavonengine/cli a migration added, then doctor passes
 * 4. nothing is pending afterwards, and running again changes nothing
 * 5. the migrated client builds with the title it had before, now from appName
 *
 * The template's files are restored afterwards, also on failure.
 *
 *   node e2e/upgrade/run.mjs
 */
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { startRegistry } from '../doctor/npm-registry.mjs'
import { check, cli, isWindows, log, readJson, repo, run, snapshotFiles, template, withPathFirst } from '../helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const TITLE = 'Old Template'

/** Run the CLI to completion and resolve with its exit code and output, whatever the code */
function mavonengine(args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], { cwd: template, env, stdio: ['ignore', 'pipe', 'pipe'] })
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

const versionOf = pkg => readJson(join(repo, 'packages', pkg, 'package.json')).version

async function main() {
  const packageJsonPath = join(template, 'package.json')
  const indexHtml = join(template, 'client', 'index.html')
  const configPath = join(template, 'mavonengine.json')
  const builtHtml = join(template, 'client', 'dist', 'index.html')
  const restore = snapshotFiles([packageJsonPath, indexHtml, configPath, builtHtml])

  // The template from before core 0.0.22
  const pkg = readJson(packageJsonPath)
  const { 'dev:server': devServer, ...scripts } = pkg.scripts
  pkg.scripts = { ...scripts, dev: devServer }
  delete pkg.devDependencies['@mavonengine/cli']
  writeFileSync(packageJsonPath, `${JSON.stringify(pkg, null, 2)}\n`)
  writeFileSync(indexHtml, readFileSync(indexHtml, 'utf8').replace('%MAVONENGINE_APP_NAME%', TITLE))
  writeFileSync(configPath, `${JSON.stringify({ plugins: {} }, null, 2)}\n`)

  const core = versionOf('core')
  const editor = versionOf('editor')
  const versions = { core: nextPatch(core), cli: nextPatch(versionOf('cli')), editor: nextPatch(editor) }
  const registry = await startRegistry({
    '@mavonengine/core': { latest: versions.core, versions: { [core]: {}, [versions.core]: {} } },
    '@mavonengine/cli': { latest: versions.cli, versions: { [versions.cli]: {} } },
    '@mavonengine/editor': { latest: versions.editor, versions: { [editor]: {}, [versions.editor]: { peerDependencies: { '@mavonengine/core': '*' } } } },
  })

  // npm is the recorder, see npm-recorder.mjs
  const bin = mkdtempSync(join(tmpdir(), 'mavonengine-npm-recorder-'))
  const recorder = join(here, 'npm-recorder.mjs')
  const npmLog = join(bin, 'npm.log')
  if (isWindows) {
    writeFileSync(join(bin, 'npm.cmd'), `@"${process.execPath}" "${recorder}" %*\r\n`)
  }
  else {
    writeFileSync(join(bin, 'npm'), `#!/bin/sh\nexec "${process.execPath}" "${recorder}" "$@"\n`)
    chmodSync(join(bin, 'npm'), 0o755)
  }
  const env = { ...withPathFirst(bin), NO_COLOR: '1', npm_config_registry: registry.url, NPM_RECORDER_LOG: npmLog }
  const npmCalls = () => existsSync(npmLog) ? readFileSync(npmLog, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line).join(' ')) : []

  try {
    log('\n== doctor on the old project')
    let result = await mavonengine(['doctor'], env)
    check(result.code === 0, 'doctor passes: pending migrations are warnings')
    check(result.output.includes('! 0.0.22-dev-script') && result.output.includes('! 0.0.25-app-name-title'), 'it lists both migrations as pending')
    check(result.output.includes('→ mavonengine upgrade --only-migrations'), 'and says how to run them')

    log('\n== upgrade --dry-run')
    const before = readFileSync(packageJsonPath, 'utf8')
    result = await mavonengine(['upgrade', '--dry-run'], env)
    check(result.code === 0, 'the dry run passes')
    check(result.output.includes(`↑ @mavonengine/core    ${core}  → ${versions.core}`), 'it moves core to the registry\'s latest')
    check(result.output.includes(`npm install @mavonengine/core@${versions.core} --save-exact`), 'it would install core pinned, as package.json has it')
    check(result.output.includes(`npm install @mavonengine/editor@${versions.editor} --save-dev --save-exact`), 'and the editor as a dev dependency')
    check(result.output.includes(`-   <title>${TITLE}</title>`) && result.output.includes('+   <title>%MAVONENGINE_APP_NAME%</title>'), 'it shows the title migration as a diff')
    check(result.output.includes('Nothing written (--dry-run)'), 'and writes nothing')
    check(readFileSync(packageJsonPath, 'utf8') === before && npmCalls().length === 0, 'package.json is the same and npm wasn\'t run')

    log('\n== upgrade --yes')
    // Not a git repository in CI (the workspace is unpacked without .git), and a dirty one locally
    result = await mavonengine(['upgrade', '--yes', '--allow-dirty'], env)
    check(result.code === 0, 'the upgrade passes, doctor included')
    const calls = npmCalls()
    check(calls[0] === `install @mavonengine/core@${versions.core} --save-exact`, 'npm installs the new core')
    check(calls[1] === `install @mavonengine/editor@${versions.editor} --save-dev --save-exact`, 'and the new editor')
    check(calls.at(-1) === 'install' && calls.length === 3, 'and runs a plain install for what the migrations added')
    const migrated = readJson(packageJsonPath)
    check(migrated.scripts.dev === 'mavonengine dev' && migrated.scripts['dev:server'] === devServer, '`npm run dev` starts mavonengine dev, the old dev script is dev:server')
    check(migrated.devDependencies['@mavonengine/cli'] === versionOf('cli'), '@mavonengine/cli is a dev dependency, at the CLI\'s version')
    check(readFileSync(indexHtml, 'utf8').includes('<title>%MAVONENGINE_APP_NAME%</title>'), 'index.html\'s title is the placeholder')
    const config = readJson(configPath)
    check(config.appName === TITLE, 'the title it had is the appName')
    check(JSON.stringify(config.migrations) === '["0.0.22-dev-script","0.0.25-app-name-title"]', 'both migrations are recorded')
    check(result.output.includes('Checking the result: mavonengine doctor') && result.output.includes('✓ none pending'), 'doctor checks the result')

    log('\n== again')
    result = await mavonengine(['doctor'], env)
    check(result.code === 0 && result.output.includes('✓ none pending'), 'doctor has no pending migrations')
    result = await mavonengine(['upgrade', '--only-migrations', '--yes', '--allow-dirty'], env)
    check(result.output.includes('none pending') && npmCalls().length === 3, 'upgrade has nothing to do')

    log('\n== the migrated client')
    await run('npm', ['run', 'build'], { cwd: join(template, 'client') })
    check(readFileSync(builtHtml, 'utf8').includes(`<title>${TITLE}</title>`), 'the built page has the title from appName')

    log('\nupgrade e2e passed')
  }
  finally {
    await registry.close()
    restore()
    rmSync(bin, { recursive: true, force: true })
  }
}

main().catch((err) => {
  process.stderr.write(`\nupgrade e2e failed: ${err.stack ?? err}\n`)
  process.exit(1)
})
