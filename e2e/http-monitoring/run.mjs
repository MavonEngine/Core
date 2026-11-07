/**
 * End-to-end test for @mavonengine/http-monitoring, run against packages/multiplayer-template:
 *
 * 1. registers the plugin in mavonengine.json with an htpasswd file holding a bcrypt user
 * 2. boots the game server with NODE_ENV=production, where the dashboard requires a login
 * 3. checks the login over HTTP: none and a wrong password are refused, the right one is let in
 * 4. opens the dashboard in Chrome, waits for live data and goes through all four tabs,
 *    failing on any console error (CSP violations included) or page error
 *
 * Needs Chrome installed (GitHub's ubuntu and windows runners have it), core and the plugin built,
 * and the template's dependencies installed. Screenshots go to e2e/http-monitoring/screenshots.
 * The template is restored afterwards, also on failure.
 *
 *   node e2e/http-monitoring/run.mjs
 */
import { Buffer } from 'node:buffer'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'
import bcrypt from 'bcryptjs'
import { chromium } from 'playwright-core'
import { base, check, linkIntoTemplate, log, repo, run, snapshotFiles, startServer, status, template } from '../helpers.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const screenshots = join(here, 'screenshots')
const PLUGIN = '@mavonengine/http-monitoring'
const USER = 'e2e'
const PASSWORD = 'correct horse battery staple'
const basic = (user, password) => `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`

async function main() {
  const configPath = join(template, 'mavonengine.json')
  const htpasswdPath = join(template, '.htpasswd')
  const restore = snapshotFiles([configPath, htpasswdPath])
  let link
  let server
  let browser
  let page

  rmSync(screenshots, { recursive: true, force: true })
  mkdirSync(screenshots, { recursive: true })

  try {
    log('\n== setup')
    link = linkIntoTemplate(PLUGIN, join(repo, 'packages/plugins/http-monitoring'))
    writeFileSync(configPath, `${JSON.stringify({ plugins: { [PLUGIN]: { enabled: true, options: { htpasswd: '.htpasswd' } } } }, null, 2)}\n`)
    // Low cost so the test stays quick, it's still the bcrypt code path
    writeFileSync(htpasswdPath, `${USER}:${bcrypt.hashSync(PASSWORD, 6)}\n`)
    await run('npm', ['run', 'build'], { cwd: join(template, 'server') })

    log('\n== production server')
    server = await startServer({ NODE_ENV: 'production' })
    check(server.output().includes(`Plugin loaded: HTTP monitoring (${PLUGIN}) (server)`), 'the server loads the plugin')
    check(server.output().includes('Monitoring dashboard at /monitoring/, login with a user from'), 'the dashboard is on, behind the htpasswd login')

    log('\n== login')
    const anonymous = await fetch(`${base}/monitoring/`)
    check(anonymous.status === 401, 'no login: 401')
    check(anonymous.headers.get('www-authenticate')?.startsWith('Basic realm="MavonEngine monitoring"'), 'the browser is asked to log in')
    check(await status('/monitoring/', { headers: { Authorization: basic(USER, 'wrong') } }) === 401, 'wrong password: 401')
    check(await status('/monitoring/api/metrics') === 401, 'the data endpoints need the login too')
    const metrics = await (await fetch(`${base}/monitoring/api/metrics`, { headers: { Authorization: basic(USER, PASSWORD) } })).json()
    check(metrics.schemaVersion === 1 && typeof metrics.engineVersion === 'string', 'the right login gets the metrics')
    check(server.output().includes(`Monitoring: failed login for "${USER}"`), 'the failed login is logged')

    log('\n== browser')
    browser = await chromium.launch({ channel: 'chrome', headless: true })
    const context = await browser.newContext({ httpCredentials: { username: USER, password: PASSWORD }, viewport: { width: 1400, height: 900 } })
    page = await context.newPage()
    const errors = []
    page.on('console', (message) => {
      if (message.type() === 'error')
        errors.push(message.text())
    })
    page.on('pageerror', error => errors.push(error.message))

    await page.goto(`${base}/monitoring/`)
    await page.locator('#status').filter({ hasText: 'LIVE' }).waitFor({ timeout: 15000 })
    check(true, 'the dashboard goes live')
    check(await page.locator('#engine').textContent() === metrics.engineVersion, 'the header shows the engine version')
    check(await page.locator('#source').textContent() === new URL(base).host, 'the header shows the server')
    check(await page.locator('#world-values dd').first().textContent() === String(metrics.players.length), 'the World panel shows the player count')
    // A couple of polls later the charts have history to draw
    await page.locator('#cpu-chart polyline').waitFor({ timeout: 10000 })
    check(await page.locator('#tick-chart polyline').count() === 2, 'the tick chart draws avg and max')
    await page.screenshot({ path: join(screenshots, 'overview.png') })

    await page.keyboard.press('2')
    await page.locator('#tab-players').waitFor({ state: 'visible' })
    check(await page.locator('#players').textContent() === 'No players connected', 'key 2 opens the Players tab')
    await page.screenshot({ path: join(screenshots, 'players.png') })

    await page.keyboard.press('3')
    await page.locator('#logs').filter({ hasText: 'Plugin loaded: HTTP monitoring' }).waitFor({ timeout: 5000 })
    check(true, 'key 3 opens the Logs tab with the server\'s log')
    check(await page.locator('#logs').filter({ hasText: 'failed login' }).count() === 1, 'the logs include the failed login as it happened')
    await page.screenshot({ path: join(screenshots, 'logs.png') })

    await page.keyboard.press('4')
    await page.locator('#requests table').waitFor({ timeout: 5000 })
    const paths = await page.locator('#requests td.path').allTextContents()
    check(paths.includes('/monitoring/'), 'key 4 opens the HTTP tab, which lists the page load')
    check(!paths.some(path => path.startsWith('/monitoring/api/')), 'the dashboard\'s own polling stays out of the HTTP tab')
    await page.screenshot({ path: join(screenshots, 'http.png') })

    check(errors.length === 0, `no console or page errors${errors.length ? `: ${errors.join(' | ')}` : ''}`)

    log('\nhttp-monitoring e2e passed')
  }
  catch (err) {
    if (server)
      process.stderr.write(`\n-- server output --\n${server.output()}\n`)
    await page?.screenshot({ path: join(screenshots, 'failure.png') }).catch(() => {})
    throw err
  }
  finally {
    await browser?.close()
    await server?.stop()
    restore()
    if (link)
      rmSync(link, { recursive: true, force: true })
  }
}

main().catch((err) => {
  process.stderr.write(`\nhttp-monitoring e2e failed: ${err.stack ?? err}\n`)
  process.exit(1)
})
