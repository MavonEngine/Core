/**
 * End-to-end test for the server's auth hook, run against packages/multiplayer-template with e2e/auth/token-plugin,
 * a plugin whose authorize() checks a fixed token. It sends geckos' connection request (the POST a client makes
 * before WebRTC starts) the way the browser does:
 *
 * 1. with the plugin: no or a wrong token gets 401, a banned one 403, a plugin that throws 500 (and the next client
 *    is still asked), the right token gets in with the plugin's identity as userData. GET /api/game/plugins marks it
 * 2. mavonengine.json names an auth plugin that isn't there: every client gets 503 instead of being let in
 * 3. without an auth plugin: everyone gets in, as before
 * 4. with the built @mavonengine/auth on @mavonengine/sqlite: a player registers over HTTP and connects with the
 *    session as that account, a guest plays and registers without losing its account, the session outlasts a
 *    restart, and a disabled account is turned away
 * 5. in Chrome, with the game client served through Vite and the auth plugin's client entry bundled into it:
 *    a tab without a session is turned away and told so (connectError 401), a player who registers joins the game
 *    as that account (network.identity, and the server's log), and a guest in a second browser joins next to it
 *
 * Needs Chrome, core and the auth and sqlite plugins built and the template's dependencies installed. The database goes to a
 * temporary directory. The template is restored afterwards, also on failure.
 *
 *   node e2e/auth/run.mjs
 *   MAVONENGINE_E2E_CHROME=/path/to/chrome node e2e/auth/run.mjs   # without Chrome installed
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { chromium } from 'playwright-core'
import { base, check, linkIntoTemplate, log, repo, run, snapshotFiles, startServer, template } from '../helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const AUTH = 'e2e-token-auth'
const REAL_AUTH = '@mavonengine/auth'
const SQLITE = '@mavonengine/sqlite'
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

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token)
    headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: body && JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => undefined) }
}

/** Open the game and press join, like a player does. The template connects when its UI says the player joined */
async function joinGame(page, name) {
  await page.goto(base)
  await page.locator('.name-input').fill(name)
  await page.locator('.join-btn').click()
}

/** Keep a session in the page the way the auth plugin's client does, so the game sends it when it connects */
async function keepSession(page, storageKey, session) {
  await page.evaluate(([key, value]) => localStorage.setItem(key, JSON.stringify(value)), [storageKey, session])
}

const waitFor = (page, fn, arg) => page.waitForFunction(fn, arg, { timeout: 60000, polling: 200 })

async function main() {
  const configPath = join(template, 'mavonengine.json')
  const restore = snapshotFiles([configPath])
  const links = []
  const dataDir = mkdtempSync(join(tmpdir(), 'mavonengine-auth-e2e-'))
  let server
  let browser
  const pageErrors = []

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
    await server.stop()
    server = undefined

    log('\n== @mavonengine/auth on @mavonengine/sqlite')
    links.push(linkIntoTemplate(REAL_AUTH, join(repo, 'packages/plugins/auth')))
    links.push(linkIntoTemplate(SQLITE, join(repo, 'packages/plugins/sqlite')))
    configure({ plugins: { [SQLITE]: { options: { path: join(dataDir, 'e2e.sqlite') } }, [REAL_AUTH]: { options: { guests: true } } } })
    server = await startServer({ LOG_LEVEL: 'debug' })
    check(server.output().includes(`Auth: Auth (${REAL_AUTH})`), 'the server uses the auth plugin')
    check(server.output().includes(`Plugin Auth (${REAL_AUTH}): ran migrations 001_init`), 'its tables are made')
    check((await connect()).status === 401, 'a client that isn\'t logged in is turned away')

    const signup = await post('/api/auth/register', { username: 'Ada', password: 'correct horse' })
    check(signup.status === 201 && typeof signup.json?.token === 'string', 'a player registers and is logged in')
    const ada = await connect(`Bearer ${signup.json.token}`)
    check(ada.status === 200 && ada.userData?.id === signup.json.account.id && ada.userData?.name === 'Ada', 'and connects as that account')
    check((await post('/api/auth/register', { username: 'ada', password: 'another one' })).status === 409, 'the name is taken, in any case')

    const guest = await post('/api/auth/guest')
    check(guest.status === 201 && guest.json?.account?.guest === true, 'a player starts as a guest')
    const asGuest = await connect(`Bearer ${guest.json.token}`)
    check(asGuest.status === 200 && asGuest.userData?.id === guest.json.account.id && asGuest.userData?.guest === true, 'and connects as that guest account')
    const claimed = await post('/api/auth/register', { username: 'Bob', password: 'correct horse' }, guest.json.token)
    check(claimed.status === 201 && claimed.json.account.id === guest.json.account.id && !claimed.json.account.guest, 'registering keeps the guest\'s account id')
    await server.stop()
    server = undefined

    log('\n== restarted')
    server = await startServer({ LOG_LEVEL: 'debug' })
    check(!server.output().includes('ran migrations'), 'the migration doesn\'t run again')
    check((await connect(`Bearer ${signup.json.token}`)).status === 200, 'the session still works')
    const again = await post('/api/auth/login', { username: 'ada', password: 'correct horse' })
    check(again.status === 200 && again.json.account.id === signup.json.account.id, 'the player logs in to the same account')
    // Without an admin token the server takes admin requests from this machine
    check((await post(`/api/auth/accounts/${signup.json.account.id}/disable`)).status === 200, 'an admin disables the account')
    check((await connect(`Bearer ${again.json.token}`)).status === 401, 'its sessions ended, so it can\'t connect')
    check((await post('/api/auth/login', { username: 'Ada', password: 'correct horse' })).status === 403, 'nor log in')
    await server.stop()
    server = undefined

    log('\n== in the browser')
    configure({ plugins: { [SQLITE]: { options: { path: join(dataDir, 'browser.sqlite') } }, [REAL_AUTH]: { options: { guests: true } } } })
    // The client through Vite, with the plugins' client entries from mavonengine.json bundled in
    server = await startServer({ LOG_LEVEL: 'debug', MAVONENGINE_DEV_CLIENT: '1' })
    const { STORAGE_KEY } = await import(pathToFileURL(join(repo, 'packages/plugins/auth/dist/client.js')).href)
    // Chrome, as in CI. MAVONENGINE_E2E_CHROME points at another Chromium, e.g. one `npx playwright install` downloaded
    const chrome = process.env.MAVONENGINE_E2E_CHROME ? { executablePath: process.env.MAVONENGINE_E2E_CHROME } : { channel: 'chrome' }
    browser = await chromium.launch({ ...chrome, headless: true, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })

    const player = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage()
    player.on('pageerror', error => pageErrors.push(`player: ${error.message}`))
    await joinGame(player, 'Eve')
    await waitFor(player, () => window.Game?.network?.connectError)
    check(await player.evaluate(() => window.Game.network.connectError.status) === 401, 'a tab without a session is turned away, and told 401')
    check(await player.evaluate(() => !window.Game.network.connected && !window.Game.network.identity), 'it is not connected, nor anyone')

    const eve = await player.evaluate(async () => (await fetch('/api/auth/register', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: 'Eve', password: 'correct horse' }) })).json())
    check(typeof eve.token === 'string', 'the player registers from the page')
    await keepSession(player, STORAGE_KEY, eve)
    await joinGame(player, 'Eve')
    await waitFor(player, () => window.Game?.network?.connected)
    check(await player.evaluate(() => window.Game.network.identity?.id) === eve.account.id, 'with the session, the game connects as that account (network.identity)')
    check(await player.evaluate(() => window.Game.network.connectError) === null, 'without a connect error')
    check(await server.waitForOutput(`as Eve (${eve.account.id})`), 'the server knows the connection is Eve\'s account')

    // Its own browser context: its own localStorage, so its own session
    const visitor = await (await browser.newContext({ viewport: { width: 1000, height: 700 } })).newPage()
    visitor.on('pageerror', error => pageErrors.push(`visitor: ${error.message}`))
    await visitor.goto(base)
    const visiting = await visitor.evaluate(async () => (await fetch('/api/auth/guest', { method: 'POST' })).json())
    check(visiting.account?.guest === true, 'a visitor plays as a guest')
    await keepSession(visitor, STORAGE_KEY, visiting)
    await joinGame(visitor, 'Visitor')
    await waitFor(visitor, () => window.Game?.network?.connected)
    check(await visitor.evaluate(() => window.Game.network.identity?.guest) === true, 'the guest joins as its guest account')
    check(await server.waitForOutput(`as ${visiting.account.name} (${visiting.account.id})`), 'the server knows the guest too')
    check(await server.waitForOutput('2 total players connected'), 'the guest plays next to the registered player')
    check(pageErrors.length === 0, `no errors in the pages${pageErrors.length ? `: ${pageErrors.join('; ')}` : ''}`)

    log('\nauth e2e passed')
  }
  catch (err) {
    if (server)
      process.stderr.write(`\n-- server output --\n${server.output()}\n`)
    throw err
  }
  finally {
    await browser?.close()
    await server?.stop()
    restore()
    for (const link of links)
      rmSync(link, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  process.stderr.write(`\nauth e2e failed: ${err.stack ?? err}\n`)
  process.exit(1)
})
