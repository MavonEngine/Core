/**
 * End-to-end test for the queue, @mavonengine/mail, @mavonengine/notifications and the auth plugin's mails, run
 * against packages/multiplayer-template with the built plugins on @mavonengine/sqlite. Mail goes over real SMTP, to
 * a small SMTP server in this test (e2e/mail/smtp.mjs), as it would to a provider's:
 *
 * 1. the plugins start on the database: the queue's, auth's and notifications' migrations run, the queue keeps its
 *    jobs in the database, mail goes through SMTP from the options with the password from the environment
 * 2. a player registers with an email and gets a mail to confirm it: in the layout, with the game's name and a link
 *    to the game's appUrl from mavonengine.json. The link's page asks, and confirms
 * 3. the player forgets the password: the mailed link sets a new one, and the old session and password stop working
 * 4. a game plugin notifies the player: kept in the database, and mailed
 * 5. `mavonengine asset:publish @mavonengine/mail` copies the layout into the project, and the next mail is in the
 *    project's changed copy
 * 6. with the SMTP server down, a mail waits on the queue in the database. The game server restarts, the SMTP server
 *    comes back, and the mail arrives
 *
 * Needs core, the CLI and the sqlite, mail, notifications and auth plugins built, and the template's dependencies
 * installed. The database goes to a temporary directory. The template is restored afterwards, also on failure.
 *
 *   node e2e/mail/run.mjs
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import process from 'node:process'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { base, check, cli, linkIntoTemplate, log, PORT, repo, run, snapshotFiles, startServer, template } from '../helpers.mjs'
import { fakeSmtp } from './smtp.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const SQLITE = '@mavonengine/sqlite'
const MAIL = '@mavonengine/mail'
const NOTIFICATIONS = '@mavonengine/notifications'
const AUTH = '@mavonengine/auth'
const REWARDS = 'e2e-rewards'
/** Another name for this machine than the requests use, so a link that has it came from appUrl */
const APP_URL = `http://127.0.0.1:${PORT}`
const APP_NAME = 'E2E Space Game'
const PASSWORD_ENV = { MAVONENGINE_MAIL_SMTP_PASSWORD: 'hunter22' }
const LINK_RE = /http:\/\/\S+?token=[\w%-]+/

const json = async path => (await fetch(`${base}${path}`)).json()

async function post(path, body, token) {
  const headers = { 'Content-Type': 'application/json' }
  if (token)
    headers.Authorization = `Bearer ${token}`
  const res = await fetch(`${base}${path}`, { method: 'POST', headers, body: body && JSON.stringify(body) })
  return { status: res.status, json: await res.json().catch(() => undefined) }
}

/** Wait for the `count`th mail to `address`, as mail goes out from the queue */
async function mailTo(smtp, address, count, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (smtp.to(address).length < count) {
    if (Date.now() > deadline)
      throw new Error(`mail ${count} to ${address} didn't arrive within ${timeoutMs} ms; it has ${smtp.to(address).length}: ${smtp.to(address).map(m => m.subject).join(', ')}`)
    await delay(100)
  }
  return smtp.to(address)[count - 1]
}

const linkIn = mail => LINK_RE.exec(mail.text)?.[0]
const tokenOf = link => decodeURIComponent(new URL(link).searchParams.get('token'))

async function main() {
  const configPath = join(template, 'mavonengine.json')
  const resources = join(template, 'resources')
  const restore = snapshotFiles([configPath, resources])
  const dataDir = mkdtempSync(join(tmpdir(), 'mavonengine-mail-e2e-'))
  const links = []
  let server
  let smtp

  try {
    log('\n== setup')
    smtp = await fakeSmtp()
    for (const pkg of [SQLITE, MAIL, NOTIFICATIONS, AUTH])
      links.push(linkIntoTemplate(pkg, join(repo, 'packages/plugins', pkg.split('/')[1])))
    links.push(linkIntoTemplate(REWARDS, join(here, 'rewards-plugin')))
    writeFileSync(configPath, `${JSON.stringify({
      appUrl: APP_URL,
      appName: APP_NAME,
      plugins: {
        [SQLITE]: { options: { path: join(dataDir, 'e2e.sqlite') } },
        // Retried quickly and often, so the test of a mail server that is down doesn't wait for long
        [MAIL]: { options: { from: `${APP_NAME} <game@example.com>`, smtp: { host: '127.0.0.1', port: smtp.port, user: 'game' }, tries: 100, backoffMs: 300 } },
        [AUTH]: {},
        [NOTIFICATIONS]: {},
        [REWARDS]: {},
      },
    }, null, 2)}\n`)
    await run('npm', ['run', 'build'], { cwd: join(template, 'server') })

    log('\n== the plugins start on the database')
    server = await startServer({ LOG_LEVEL: 'debug', ...PASSWORD_ENV })
    const output = () => server.output()
    check(output().includes(`Database: SQLite (${SQLITE})`), 'the server uses the sqlite plugin\'s database')
    check(output().includes('Queue: ran migrations 001_create_jobs'), 'the queue\'s migration makes its tables')
    check(output().includes(`Plugin Auth (${AUTH}): ran migrations 001_init, 002_tokens`), 'auth\'s migrations run, with the tokens of mailed links')
    check(output().includes(`Plugin Notifications (${NOTIFICATIONS}): ran migrations 001_create_notifications`), 'so do the notifications\'')
    check(output().includes('Mail: sending through smtp'), 'mail goes through SMTP from the options')
    check(output().includes(`Notifications: Notifications (${NOTIFICATIONS})`), 'the server sends notify() through the notifications plugin')

    const metrics = await json('/api/game/metrics')
    check(metrics.queue?.driver === 'database' && metrics.queue.working === true, 'the queue keeps its jobs in the database and works them, as the metrics say')
    const tables = (await json('/api/game/database')).tables
    check(tables.some(t => t.name === 'core_jobs' && t.plugin === '@mavonengine/core'), 'its table shows as the engine\'s in the database')
    check(tables.some(t => t.name === 'auth_tokens') && tables.some(t => t.name === 'notifications_notifications'), 'and the plugins\' new tables')

    log('\n== confirming an email')
    const signup = await post('/api/auth/register', { username: 'Ada', password: 'correct horse', email: 'ada@example.com' })
    check(signup.status === 201 && signup.json.account.emailVerified === false, 'a player registers with an email, not confirmed yet')
    const confirm = await mailTo(smtp, 'ada@example.com', 1)
    check(confirm.subject === 'Confirm your email address', 'a mail to confirm it arrives over SMTP')
    check(confirm.auth === '\0game\0hunter22', 'logged in to the SMTP server with the password from the environment')
    check(confirm.headers.from === `"${APP_NAME}" <game@example.com>` || confirm.headers.from === `${APP_NAME} <game@example.com>`, 'from the sender in the options')
    check(confirm.html?.includes(`<title>Confirm your email address</title>`) && confirm.html.includes(`&copy; ${new Date().getFullYear()} ${APP_NAME}`), 'in the layout, with the game\'s name from mavonengine.json')
    const confirmLink = linkIn(confirm)
    check(confirmLink?.startsWith(`${APP_URL}/api/auth/verify-email?token=`), 'its link goes to the game\'s appUrl')

    const page = await fetch(confirmLink)
    const pageHtml = await page.text()
    check(page.status === 200 && pageHtml.includes('Confirm that ada@example.com is your email address'), 'the link\'s page asks before confirming')
    const confirmed = await fetch(`${base}/api/auth/verify-email`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token: tokenOf(confirmLink) }).toString(),
    })
    check(confirmed.status === 200 && (await confirmed.text()).includes('ada@example.com is confirmed'), 'its button confirms the email')
    const me = await (await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${signup.json.token}` } })).json()
    check(me.account.emailVerified === true, 'the account says so')

    log('\n== a forgotten password')
    check((await post('/api/auth/forgot-password', { email: 'ADA@example.com' })).status === 202, 'the player asks for a reset link')
    check((await post('/api/auth/forgot-password', { email: 'nobody@example.com' })).status === 202, 'an email without an account gets the same answer')
    const reset = await mailTo(smtp, 'ada@example.com', 2)
    check(reset.subject === 'Reset your password', 'a reset mail arrives, only to the account\'s email')
    const resetLink = linkIn(reset)
    check((await fetch(resetLink)).status === 200, 'its link opens the form')
    const renewed = await post('/api/auth/reset-password', { token: tokenOf(resetLink), password: 'brand new horse' })
    check(renewed.status === 200 && typeof renewed.json.token === 'string', 'a new password is set, and the player logged in')
    check((await fetch(`${base}/api/auth/me`, { headers: { Authorization: `Bearer ${signup.json.token}` } })).status === 401, 'the session from before is logged out')
    check((await post('/api/auth/login', { username: 'Ada', password: 'correct horse' })).status === 401, 'the old password doesn\'t work')
    check((await post('/api/auth/login', { username: 'Ada', password: 'brand new horse' })).status === 200, 'the new one does')
    check(smtp.to('nobody@example.com').length === 0, 'nothing went to the email without an account')

    log('\n== a notification')
    const accountId = signup.json.account.id
    const rewarded = await post(`/api/e2e/reward/${accountId}`)
    check(rewarded.status === 200 && rewarded.json.stored.length === 1 && rewarded.json.stored[0].data.coins === 50 && rewarded.json.stored[0].readAt === null, 'a game plugin notifies the player, and it is kept unread')
    const rewardMail = await mailTo(smtp, 'ada@example.com', 3)
    check(rewardMail.subject === 'You got 50 coins' && rewardMail.text.includes('Spend them well'), 'and mailed, to the account\'s email from the auth plugin')

    log('\n== the project\'s own mail layout')
    await run(process.execPath, [cli, 'asset:publish', MAIL], { cwd: template })
    const layout = join(resources, '@mavonengine', 'mail', 'layout.html')
    check(existsSync(layout) && readFileSync(layout, 'utf8').includes('{{{ content }}}'), 'mavonengine asset:publish copies the layout into the project')
    writeFileSync(layout, '<html><body data-e2e="ours"><h1>{{ appName }}</h1>{{{ content }}}</body></html>')
    await post(`/api/e2e/reward/${accountId}`)
    const ownLayout = await mailTo(smtp, 'ada@example.com', 4)
    check(ownLayout.html?.includes('data-e2e="ours"') && ownLayout.html.includes(`<h1>${APP_NAME}</h1>`), 'the next mail is in the project\'s changed copy, without a restart')

    log('\n== a mail server that is down')
    await smtp.close()
    check((await post('/api/auth/forgot-password', { email: 'ada@example.com' })).status === 202, 'a reset is asked for while mail can\'t be delivered')
    const deadline = Date.now() + 10000
    while (!output().includes('failed try') && Date.now() < deadline)
      await delay(100)
    check(output().includes('Job mail:send') && output().includes('failed try'), 'the mail fails, and is tried again')
    const waiting = await json('/api/game/database/tables/core_jobs')
    check(waiting.total === 1 && waiting.rows[0].name === 'mail:send', 'it waits on the queue, in the database')
    await server.stop()
    server = undefined

    await smtp.listen()
    server = await startServer({ LOG_LEVEL: 'debug', ...PASSWORD_ENV })
    const late = await mailTo(smtp, 'ada@example.com', 5)
    check(late.subject === 'Reset your password', 'after a restart, with the mail server back, it arrives')
    const done = Date.now() + 5000
    while ((await json('/api/game/database/tables/core_jobs')).total > 0 && Date.now() < done)
      await delay(100)
    check((await json('/api/game/database/tables/core_jobs')).total === 0, 'and is taken off the queue')

    log('\nmail e2e passed')
  }
  catch (err) {
    if (server)
      process.stderr.write(`\n-- server output --\n${server.output()}\n`)
    throw err
  }
  finally {
    await server?.stop()
    await smtp?.close().catch(() => {})
    restore()
    for (const link of links)
      rmSync(link, { recursive: true, force: true })
    rmSync(dataDir, { recursive: true, force: true })
  }
}

main().catch((err) => {
  process.stderr.write(`\nmail e2e failed: ${err.stack ?? err}\n`)
  process.exit(1)
})
