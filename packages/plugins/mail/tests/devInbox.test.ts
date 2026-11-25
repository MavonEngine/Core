import type { ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { Server as NodeServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import type { DevInbox } from '../src/devInbox'
import { Buffer } from 'node:buffer'
import { mkdtempSync, rmSync } from 'node:fs'
import { connect } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import AdminPanel from '@mavonengine/core/Networking/Server/Admin/AdminPanel'
import Queue from '@mavonengine/core/Queue/Queue'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { devInboxTransport, loadMailDev, startDevInbox } from '../src/devInbox'
import plugin from '../src/index'
import { logTransport } from '../src/transports'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
  vi.unstubAllEnvs()
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mavonengine-maildev-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

async function inboxMails(port: number, basePath = ''): Promise<any[]> {
  return (await fetch(`http://127.0.0.1:${port}${basePath}/api/email`)).json()
}

const message = {
  to: [
    { address: 'ada@example.com', name: 'Ada' },
  ],
  subject: 'Welcome',
  text: 'Hello Ada',
  html: '<p>Hello <b>Ada</b></p>',
}

describe('dev inbox', () => {
  it('runs MailDev on free local ports and keeps the mail sent to it, with a sender when it has none', async () => {
    const inbox = (await startDevInbox({
      basePath: '',
      mailDirectory: tempDir(),
    }))!
    cleanups.push(() => inbox.stop())
    const transport = devInboxTransport(Promise.resolve(inbox), logTransport(undefined), () => 'game@localhost')
    cleanups.push(() => transport.close?.())

    expect(transport.name).toBe('maildev')
    await transport.send(message)

    const [mail] = await inboxMails(inbox.webPort)
    expect(mail).toMatchObject({
      subject: 'Welcome',
      from: [
        { address: 'game@localhost' },
      ],
      to: [
        { address: 'ada@example.com' },
      ],
    })
  })

  it('writes mail to the log when MailDev isn\'t there or couldn\'t start', async () => {
    const logger = {
      info: vi.fn(),
    }
    for (const inbox of [
      Promise.resolve(undefined),
      Promise.reject(new Error('port taken')),
    ]) {
      inbox.catch(() => {})
      await devInboxTransport(inbox as Promise<DevInbox | undefined>, logTransport(logger), () => 'x@localhost').send(message)
    }
    expect(logger.info).toHaveBeenCalledTimes(2)
    expect(logger.info.mock.calls[0][0]).toMatch(/ada@example.com.*: Welcome/)
  })

  it('tells a project without maildev from one where it broke', async () => {
    const missing = Object.assign(new Error('Cannot find package \'maildev\''), { code: 'ERR_MODULE_NOT_FOUND' })
    expect(await loadMailDev(() => Promise.reject(missing))).toBeUndefined()
    expect(await startDevInbox({ basePath: '' }, () => Promise.reject(missing))).toBeUndefined()
    await expect(loadMailDev(() => Promise.reject(new Error('syntax error')))).rejects.toThrow('syntax error')
  })
})

/** The mail plugin on a server with core's admin panel, as `mavonengine dev` runs it */
async function startedPlugin({ token = 'admin-token', env = 'development' }: { token?: string, env?: string } = {}) {
  vi.stubEnv('NODE_ENV', env)
  const app = express()
  const panel = new AdminPanel({
    adminToken: {
      configured: true,
      matches: candidate => candidate === token,
    },
    production: () => false,
  })
  panel.mount(app)
  const listener: NodeServer = await new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server))
  })
  cleanups.push(() => new Promise<void>(resolve => listener.close(() => resolve())))

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const queue = new Queue(logger, { pollIntervalMs: 10 })
  const requests = {
    ignorePrefix: vi.fn(),
  }
  const ctx = {
    package: '@mavonengine/mail',
    options: {},
    logger,
    server: {
      http: { server: listener },
      requests,
    },
    queue,
    admin: panel.forPlugin('@mavonengine/mail'),
    projectRoot: tempDir(),
  } as unknown as ServerPluginContext

  const api = plugin.api(ctx)
  plugin.setup(ctx)
  plugin.http(app, ctx)
  app.use((_req, res) => void res.send('game'))
  cleanups.push(async () => {
    await plugin.destroy(ctx)
    await queue.stop()
  })

  const port = (listener.address() as AddressInfo).port
  const get = (path: string, headers: Record<string, string> = {}) => fetch(`http://127.0.0.1:${port}${path}`, {
    headers: { Authorization: `Bearer ${token}`, ...headers },
    redirect: 'manual',
  })
  return {
    api,
    ctx,
    logger,
    requests,
    panel,
    port,
    get,
  }
}

describe('dev inbox in the admin panel', () => {
  it('sends mail into the inbox and shows it on the Mail page, behind the admin login', async () => {
    const { api, logger, requests, panel, get } = await startedPlugin()

    expect(api.transport).toBe('maildev')
    await vi.waitFor(() => expect(logger.info).toHaveBeenCalledWith('Mail: no transport set up, mail goes to the dev inbox at /admin/mail/ in the admin panel'), { timeout: 15_000 })
    expect(panel.list().map(page => page.path)).toContain('mail')
    expect(requests.ignorePrefix).toHaveBeenCalledWith('/admin/mail/inbox/')

    // No sender set up: the inbox doesn't need one
    expect(await api.send({ to: 'ada@example.com', subject: 'Welcome', text: 'Hello Ada' }, { queued: false })).toMatchObject({ queued: false, transport: 'maildev' })

    const page = await (await get('/admin/mail/')).text()
    expect(page).toContain('<iframe class="adm-frame" src="/admin/mail/inbox/" title="Dev inbox"></iframe>')
    expect(page).toContain('href="/admin/mail/" aria-current="page"')

    const ui = await get('/admin/mail/inbox/', { Accept: 'text/html' })
    expect(ui.status).toBe(200)
    const html = await ui.text()
    expect(html).toContain('<base href="/admin/mail/inbox/" />')
    // Dark by default: the theme script runs in the head, before MailDev's own
    expect(html.indexOf('<script src="/admin/mail/inbox/_mavonengine/theme.js"></script>')).toBeGreaterThan(-1)
    expect(html.indexOf('_mavonengine/theme.js')).toBeLessThan(html.indexOf('type="module"'))
    const theme = await get('/admin/mail/inbox/_mavonengine/theme.js')
    expect(theme.headers.get('content-type')).toContain('text/javascript')
    expect(await theme.text()).toContain('theme: \'dark\'')
    // Framed by the admin page, and its own policy instead of the panel's
    expect(ui.headers.get('x-frame-options')).toBe('SAMEORIGIN')
    expect(ui.headers.get('content-security-policy')).toContain('frame-ancestors \'self\'')
    expect(ui.headers.get('content-security-policy')).toContain('base-uri \'self\'')

    const mails = await (await get('/admin/mail/inbox/api/email')).json() as any[]
    expect(mails.map(mail => mail.subject)).toEqual(['Welcome'])
    expect(mails[0].html).toContain('Hello Ada')
    // The mail's html is left as it is
    const mailHtml = await (await get(`/admin/mail/inbox/api/email/${mails[0].id}/html`)).text()
    expect(mailHtml).toContain('Hello Ada')
    expect(mailHtml).not.toContain('theme.js')

    expect((await get('/admin/mail/inbox/api/email', { Authorization: 'Bearer wrong' })).status).toBe(401)
    expect((await get('/admin/mail/', { Authorization: 'Bearer wrong' })).status).toBe(401)
  })

  it('turns away WebSocket upgrades of the inbox, which would get past the login', async () => {
    const { port } = await startedPlugin()

    const closed = await new Promise<boolean>((resolve) => {
      const socket = connect(port, '127.0.0.1', () => {
        socket.write([
          'GET /admin/mail/inbox/socket.io/?EIO=4&transport=websocket HTTP/1.1',
          `Host: 127.0.0.1:${port}`,
          'Connection: Upgrade',
          'Upgrade: websocket',
          'Sec-WebSocket-Version: 13',
          `Sec-WebSocket-Key: ${Buffer.from('0123456789abcdef').toString('base64')}`,
          '',
          '',
        ].join('\r\n'))
      })
      let answer = ''
      socket.on('data', chunk => void (answer += chunk))
      socket.on('close', () => resolve(!answer.includes('101')))
      setTimeout(() => {
        socket.destroy()
        resolve(false)
      }, 3000)
    })
    expect(closed).toBe(true)
  })

  it('stays away in production and tests, and when an SMTP server is set up', async () => {
    const production = await startedPlugin({ env: 'production' })
    expect(production.api.transport).toBe('log')
    expect(production.panel.list().map(page => page.path)).not.toContain('mail')
    expect(await (await production.get('/admin/mail/inbox/', { Accept: 'text/html' })).text()).toBe('game')
  })
})
