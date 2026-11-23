/**
 * End-to-end test for `mavonengine make:plugin`, run against packages/multiplayer-template:
 *
 * 1. `mavonengine make:plugin forest --no-install` writes plugins/forest/, adds plugins/* to the workspaces and
 *    registers it in mavonengine.json. The plugin is then linked into node_modules like `npm install` does
 * 2. the generated sources typecheck against the installed @mavonengine/core
 * 3. dev server: Node loads the TypeScript server entry as it is and its route answers, and Vite lists and
 *    compiles the client entry, without a build step
 *
 * Needs the cli and core built and the template's dependencies installed (with core npm-linked in CI).
 * The template's files are restored afterwards, also on failure.
 *
 *   node e2e/make-plugin/run.mjs
 */
import { existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import process from 'node:process'
import { base, check, cli, linkIntoTemplate, log, readJson, run, snapshotFiles, startServer, template } from '../helpers.mjs'

const PLUGIN = 'forest'
const CLIENT_IMPORT_RE = /import plugin\d+ from "([^"]+client\.ts[^"]*)"/

async function main() {
  const pluginDir = join(template, 'plugins', PLUGIN)
  const pluginsDir = join(template, 'plugins')
  const pluginsDirExisted = existsSync(pluginsDir)
  const restore = snapshotFiles([join(template, 'package.json'), join(template, 'mavonengine.json')])

  let server
  try {
    log('\n== mavonengine make:plugin')
    const output = await run(process.execPath, [cli, 'make:plugin', PLUGIN, '--no-install'], { cwd: join(template, 'client') })
    check(output.includes(`created ${PLUGIN} in plugins/${PLUGIN}/`), 'make:plugin reports what it created')
    check(existsSync(join(pluginDir, 'src/client.ts')) && existsSync(join(pluginDir, 'src/server.ts')), 'both entries are written')
    check(readJson(join(template, 'package.json')).workspaces.includes('plugins/*'), 'plugins/* is a workspace')
    check(readJson(join(template, 'mavonengine.json')).plugins[PLUGIN]?.enabled === true, `${PLUGIN} is in mavonengine.json`)
    linkIntoTemplate(PLUGIN, pluginDir)

    log('\n== typecheck')
    await run(process.execPath, [join(template, 'node_modules/typescript/bin/tsc'), '-p', join(pluginDir, 'tsconfig.json')], { cwd: pluginDir })
    check(true, 'the generated sources typecheck')

    log('\n== dev server')
    await run('npm', ['run', 'build'], { cwd: join(template, 'server') })
    server = await startServer({ MAVONENGINE_DEV_CLIENT: '1', LOG_LEVEL: 'debug' })
    check(server.output().includes(`${PLUGIN} loaded on the server`), 'the server runs the TypeScript entry as it is')
    check((await (await fetch(`${base}/api/${PLUGIN}/status`)).json()).ok === true, 'the plugin\'s route answers')

    const virtualModule = await (await fetch(`${base}/@id/__x00__virtual:mavonengine/plugins`)).text()
    check(virtualModule.includes(`package: "${PLUGIN}"`), 'the client virtual module lists the plugin')
    const entry = CLIENT_IMPORT_RE.exec(virtualModule)?.[1]
    check(!!entry, 'the virtual module imports the client entry')
    const compiled = await fetch(`${base}${entry}`)
    const code = await compiled.text()
    check(compiled.ok && code.includes('loaded on the client'), 'Vite compiles and serves the client entry')

    log('\nmake:plugin e2e passed')
  }
  catch (err) {
    if (server)
      process.stderr.write(`\n-- server output --\n${server.output()}\n`)
    throw err
  }
  finally {
    await server?.stop()
    restore()
    rmSync(join(template, 'node_modules', PLUGIN), { recursive: true, force: true })
    rmSync(pluginsDirExisted ? pluginDir : pluginsDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  process.stderr.write(`\nmake:plugin e2e failed: ${err.stack ?? err}\n`)
  process.exit(1)
})
