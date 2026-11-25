import type { PluginTool, ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { Server as NodeServer } from 'node:http'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import process from 'node:process'
import AdminPanel from '@mavonengine/core/Networking/Server/Admin/AdminPanel'
import Queue from '@mavonengine/core/Queue/Queue'
import express from 'express'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createDevPlugin, DevInboxClient, linksOf, mailTools } from '../src/dev'
import { INBOX_FILE, mailDataDir, removeInboxLocation, writeInboxLocation } from '../src/inboxFile'
import plugin from '../src/index'

const cleanups: (() => Promise<void> | void)[] = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse())
    await cleanup()
  vi.unstubAllEnvs()
})

function tempDir() {
  const dir = mkdtempSync(join(tmpdir(), 'mavonengine-mail-dev-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  return dir
}

/** The mail plugin in a game server in development, with the admin panel and the dev inbox */
async function startedServer() {
  vi.stubEnv('NODE_ENV', 'development')
  const app = express()
  const panel = new AdminPanel({
    adminToken: {
      configured: true,
      matches: candidate => candidate === 'admin-token',
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
  const projectRoot = tempDir()
  const ctx = {
    package: '@mavonengine/mail',
    options: {},
    logger,
    server: {
      http: { server: listener },
      requests: {
        ignorePrefix: vi.fn(),
      },
    },
    queue,
    admin: panel.forPlugin('@mavonengine/mail'),
    projectRoot,
  } as unknown as ServerPluginContext

  const api = plugin.api(ctx)
  plugin.setup(ctx)
  plugin.http(app, ctx)
  let stopped = false
  const stop = async () => {
    if (stopped)
      return
    stopped = true
    await plugin.destroy(ctx)
    await queue.stop()
  }
  cleanups.push(stop)

  const dataDir = mailDataDir(projectRoot)
  // MailDev's first start loads it and binds its ports, which takes Windows runners over waitFor's default second
  await vi.waitFor(() => expect(existsSync(join(dataDir, INBOX_FILE))).toBe(true), { timeout: 15_000 })
  return { api, queue, dataDir, stop }
}

function toolsFor(dataDir: string): Record<string, PluginTool> {
  return Object.fromEntries(mailTools(new DevInboxClient(dataDir)).map(tool => [tool.name, tool]))
}

describe('the dev entry\'s tools for AI assistants', () => {
  it('is a dev plugin with the mail_ tools', () => {
    const tools = createDevPlugin().mcpTools!({
      dataDir: tempDir(),
    } as any)
    expect(tools.map(tool => [tool.name, tool.readOnly === true, tool.destructive === true])).toEqual([
      ['inbox', true, false],
      ['read', true, false],
      ['clear', false, true],
    ])
  })

  it('lists, reads and clears the mail the game sent, through the inbox the server named', async () => {
    const { api, dataDir } = await startedServer()
    expect(JSON.parse(readFileSync(join(dataDir, INBOX_FILE), 'utf8'))).toEqual({
      api: expect.stringMatching(/^http:\/\/127\.0\.0\.1:\d+\/admin\/mail\/inbox\/api$/),
      pid: process.pid,
    })

    await api.send({
      to: 'Ada <ada@example.com>',
      subject: 'Verify your address',
      html: '<p>Hi Ada,</p><p><a href="http://localhost:8050/verify?token=abc&amp;id=1">Verify</a></p><p><a href="mailto:help@example.com">Help</a></p>',
    }, { queued: false })
    await api.send({ to: 'bob@example.com', subject: 'Welcome', text: 'Hello Bob, see https://example.com/start.' }, { queued: false })

    const tools = toolsFor(dataDir)
    const all = await tools.inbox.run({}) as any
    expect(all).toMatchObject({ inboxTotal: 2, inboxUnread: 2, matched: 2 })
    // Newest first, by the mail's Date header, which counts whole seconds: these two may tie
    expect(all.mail.map((mail: any) => mail.subject).sort()).toEqual(['Verify your address', 'Welcome'])

    const forAda = await tools.inbox.run({ to: 'ADA@example.com' }) as any
    expect(forAda.mail).toEqual([
      expect.objectContaining({
        subject: 'Verify your address',
        to: ['Ada <ada@example.com>'],
        from: ['game@localhost'],
        read: false,
      }),
    ])

    const verify = await tools.read.run({ to: 'ada@example.com' }) as any
    expect(verify).toMatchObject({
      id: forAda.mail[0].id,
      subject: 'Verify your address',
      links: ['http://localhost:8050/verify?token=abc&id=1'],
    })
    expect(verify.text).toContain('Hi Ada,')
    expect(verify.text).not.toContain('<')
    expect(verify).not.toHaveProperty('html')

    const welcome = await tools.read.run({ subject: 'welcome', html: true }) as any
    expect(welcome).toMatchObject({
      text: 'Hello Bob, see https://example.com/start.',
      links: ['https://example.com/start'],
    })
    expect(welcome).toHaveProperty('html')
    expect((await tools.inbox.run({ unread: true }) as any).matched).toBe(0)

    expect(await tools.clear.run({ id: verify.id })).toEqual({
      deleted: [verify.id],
    })
    await expect(tools.read.run({ id: verify.id })).rejects.toThrow(`No mail ${verify.id} in the dev inbox`)
    expect(await tools.clear.run({})).toEqual({ deleted: 1 })
    expect((await tools.inbox.run({}) as any).inboxTotal).toBe(0)
  })

  it('waits for mail the game queued', async () => {
    const { api, queue, dataDir } = await startedServer()
    const tools = toolsFor(dataDir)

    await expect(tools.read.run({ to: 'ada@example.com' })).rejects.toThrow('No mail to ada@example.com in the dev inbox')

    await api.send({ to: 'ada@example.com', subject: 'Reset your password', text: 'Go to http://localhost:8050/reset?token=xyz' })
    const reading = tools.read.run({ to: 'ada@example.com', subject: 'reset', waitSeconds: 10 })
    setTimeout(() => queue.start(), 300)
    expect(await reading).toMatchObject({
      links: ['http://localhost:8050/reset?token=xyz'],
    })
  })

  it('says how to get an inbox when the server runs none, or stopped', async () => {
    const tools = toolsFor(tempDir())
    await expect(tools.inbox.run({})).rejects.toThrow('No dev inbox is running')

    const { dataDir, stop } = await startedServer()
    const location = readFileSync(join(dataDir, INBOX_FILE), 'utf8')
    await stop()
    expect(existsSync(join(dataDir, INBOX_FILE))).toBe(false)

    // A server that died without removing it
    writeInboxLocation(dataDir, JSON.parse(location).api.split(':')[2].split('/')[0], '/admin/mail/inbox')
    await expect(toolsFor(dataDir).inbox.run({})).rejects.toThrow('doesn\'t answer')
  })

  it('checks its arguments', async () => {
    const tools = toolsFor(tempDir())
    await expect(tools.read.run({})).rejects.toThrow('Give id, or to and/or subject')
    await expect(tools.read.run({ id: 42 })).rejects.toThrow('id must be a non-empty string')
  })
})

describe('the inbox file', () => {
  it('is only removed by the server that wrote it', () => {
    const dir = tempDir()
    const first = writeInboxLocation(dir, 1111, '')
    const second = writeInboxLocation(dir, 2222, '')
    removeInboxLocation(dir, first)
    expect(existsSync(join(dir, INBOX_FILE))).toBe(true)
    removeInboxLocation(dir, second)
    expect(existsSync(join(dir, INBOX_FILE))).toBe(false)
  })
})

describe('links', () => {
  it('takes them from the html and text, once each, without mailto: and trailing punctuation', () => {
    expect(linksOf({
      html: '<a href="https://a.example/x?y=1&amp;z=2">a</a> <a href=\'mailto:x@y\'>m</a> <a href="#top">t</a> <a href="https://a.example/x?y=1&z=2">again</a>',
      text: 'Open https://b.example/path). Or https://a.example/x?y=1&z=2.',
    })).toEqual(['https://a.example/x?y=1&z=2', 'https://b.example/path'])
  })
})
