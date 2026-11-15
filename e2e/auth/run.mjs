/**
 * End-to-end test for the server's auth hook, run against packages/multiplayer-template with e2e/auth/token-plugin,
 * a plugin whose authorize() checks a fixed token. It sends geckos' connection request (the POST a client makes
 * before WebRTC starts) the way the browser does:
 *
 * 1. with the plugin: no or a wrong token gets 401, a banned one 403, a plugin that throws 500 (and the next client
 *    is still asked), the right token gets in with the plugin's identity as userData. GET /api/game/plugins marks it
 * 2. mavonengine.json names an auth plugin that isn't there: every client gets 503 instead of being let in
 * 3. without an auth plugin: everyone gets in, as before
 *
 * Needs core built and the template's dependencies installed. The template is restored afterwards, also on failure.
 *
 *   node e2e/auth/run.mjs
 */
import { rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import { base, check, linkIntoTemplate, log, run, snapshotFiles, startServer, template } from '../helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const AUTH = 'e2e-token-auth'
// The template's client connects through /socket on the HTTP port, and geckos answers its routes under any prefix
const CONNECTIONS = `${base}/socket/.wrtc/v2/connections`

/** Ask to connect, like geckos' client does, and close the connection again if it was let in */
async function connect(authorization) {
  const headers = { 'Content-Type': 'application/json' }
  if (authorization)
    headers.Authorization = authorization
  const res = await fetch(CONNECTIONS, { method: 'POST', headers })
  if (res.status !== 200)
    return { status: res.status }

  const body = await res.json()
  await fetch(`${CONNECTIONS}/${body.id}/close`, { method: 'POST' })
  return { status: res.status, userData: body.userData }
}

const json = async path => (await fetch(`${base}${path}`)).json()

async function main() {
  const configPath = join(template, 'mavonengine.json')
  const restore = snapshotFiles([configPath])
  const links = []
  let server

  const configure = (config) => {
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
  }

  try {
    log('\n== setup')
    links.push(linkIntoTemplate(AUTH, join(here, 'token-plugin')))
    configure({ plugins: { [AUTH]: {} } })
    await run('npm', ['run', 'build'], { cwd: join(template, 'server') })

    log('\n== with an auth plugin')
    server = await startServer({ LOG_LEVEL: 'debug' })
    check(server.output().includes(`Auth: Token auth (${AUTH})`), 'the server uses the auth plugin')
    check((await connect()).status === 401, 'a client without a token is turned away with 401')
    check((await connect('Bearer wrong')).status === 401, 'so is one with a wrong token')
    check((await connect('Bearer banned')).status === 403, 'the plugin\'s own status comes through, 403 for a banned one')
    check((await connect('Bearer boom')).status === 500, 'a plugin that throws turns that client away with 500')
    check(server.output().includes('failed in authorize(), turning the client away'), 'and the throw is logged')
    const alice = await connect('Bearer good')
    check(alice.status === 200, 'the right token gets in, also after the plugin threw')
    check(alice.userData?.id === 'acc-1' && alice.userData?.name === 'alice', 'and the client is told its identity')
    const plugins = (await json('/api/game/plugins')).plugins
    check(plugins.find(p => p.package === AUTH)?.auth === true, 'GET /api/game/plugins marks the auth plugin')
    await server.stop()
    server = undefined

    log('\n== the auth plugin mavonengine.json names isn\'t there')
    configure({ plugins: {}, auth: AUTH })
    server = await startServer({ LOG_LEVEL: 'debug' })
    check(server.output().includes('auth plugin is not running, so every client is turned away'), 'the server says it turns everyone away')
    check((await connect('Bearer good')).status === 503, 'and does, with 503, instead of letting them in unchecked')
    await server.stop()
    server = undefined

    log('\n== without an auth plugin')
    configure({ plugins: {} })
    server = await startServer({ LOG_LEVEL: 'debug' })
    const anyone = await connect()
    check(anyone.status === 200, 'every client gets in, as before')
    check(!anyone.userData?.id, 'without an identity')

    log('\nauth e2e passed')
  }
  catch (err) {
    if (server)
      process.stderr.write(`\n-- server output --\n${server.output()}\n`)
    throw err
  }
  finally {
    await server?.stop()
    restore()
    for (const link of links)
      rmSync(link, { recursive: true, force: true })
  }
}

main().catch((err) => {
  process.stderr.write(`\nauth e2e failed: ${err.stack ?? err}\n`)
  process.exit(1)
})
