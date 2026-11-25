import type { ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { MailApi, MailTransport } from '../src/index'
import Queue from '@mavonengine/core/Queue/Queue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import plugin, { FROM_ENV, mail, Mailable, memoryTransport, parseOptions, SMTP_PASSWORD_ENV, SMTP_URL_ENV, smtpConfig } from '../src/index'

class Welcome extends Mailable {
  constructor(private name: string) {
    super()
  }

  subject() {
    return `Welcome, ${this.name}`
  }

  text() {
    return `Good to have you, ${this.name}.`
  }
}

const started: { ctx: ServerPluginContext, queue: Queue }[] = []

afterEach(async () => {
  for (const { ctx, queue } of started.splice(0)) {
    await plugin.destroy(ctx)
    await queue.stop()
  }
  vi.unstubAllEnvs()
})

function start(options: Record<string, unknown> = { from: 'Game <game@example.com>' }) {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }
  const queue = new Queue(logger, { pollIntervalMs: 10 })
  const server = {}
  const ctx = {
    package: '@mavonengine/mail',
    options,
    logger,
    server,
    queue,
  } as unknown as ServerPluginContext
  const api = plugin.api(ctx)
  plugin.setup(ctx)
  started.push({ ctx, queue })
  return { api, ctx, queue, logger, server }
}

describe('mail plugin', () => {
  it('queues mail by default and sends it once the queue runs it', async () => {
    const { api, queue } = start()
    const memory = memoryTransport()
    api.useTransport(memory)

    const result = await api.to('Player <player@example.com>').send(new Welcome('Ada'))

    expect(result).toEqual({
      queued: true,
      jobId: expect.any(String),
    })
    expect(await queue.size()).toBe(1)
    expect(memory.sent).toEqual([])

    queue.start()
    await vi.waitFor(() => expect(memory.sent).toEqual([
      {
        from: { address: 'game@example.com', name: 'Game' },
        to: [
          { address: 'player@example.com', name: 'Player' },
        ],
        subject: 'Welcome, Ada',
        text: 'Good to have you, Ada.',
        // Text alone gets html, in the layout
        html: expect.stringContaining('<p style="margin: 0 0 16px;">Good to have you, Ada.</p>'),
      },
    ]))
  })

  it('sends right away with sendNow(), a mailable or the options that say so', async () => {
    const memory = memoryTransport()
    const { api, queue } = start({ from: 'game@example.com' })
    api.useTransport(memory)

    expect(await api.to('a@example.com').sendNow(new Welcome('A'))).toEqual({ queued: false, transport: 'memory', messageId: 'memory-1' })

    class Receipt extends Welcome {
      queued = false
    }
    await api.to('b@example.com').send(new Receipt('B'))
    await api.send({ to: 'c@example.com', subject: 'Hi', text: 'x' }, { queued: false })

    const notQueued = start({ from: 'game@example.com', queued: false })
    notQueued.api.useTransport(memory)
    await notQueued.api.to('d@example.com').send(new Welcome('D'))

    expect(memory.sent.map(m => m.to[0].address)).toEqual([
      'a@example.com',
      'b@example.com',
      'c@example.com',
      'd@example.com',
    ])
    expect(await queue.size()).toBe(0)
  })

  it('queues a delayed mail, also when it would be sent right away', async () => {
    const { api, queue } = start({ from: 'game@example.com', queued: false })
    api.useTransport(memoryTransport())
    expect(await api.to('a@example.com').send(new Welcome('A'), { delayMs: 60_000 })).toMatchObject({ queued: true })
    expect(await queue.size()).toBe(1)
  })

  it('puts cc and bcc on the mail, and the mailable\'s sender and headers', async () => {
    const memory = memoryTransport()
    const { api } = start()
    api.useTransport(memory)

    class Report extends Mailable {
      from = 'Reports <reports@example.com>'
      replyTo = 'support@example.com'
      subject() {
        return 'Report'
      }

      html() {
        return '<b>3 cheaters</b>'
      }

      headers() {
        return { 'X-Report': 'weekly' }
      }
    }
    await api.to('a@example.com').cc('b@example.com').bcc('c@example.com', 'd@example.com').sendNow(new Report())

    expect(memory.sent[0]).toEqual({
      from: { address: 'reports@example.com', name: 'Reports' },
      to: [
        { address: 'a@example.com' },
      ],
      cc: [
        { address: 'b@example.com' },
      ],
      bcc: [
        { address: 'c@example.com' },
        { address: 'd@example.com' },
      ],
      replyTo: { address: 'support@example.com' },
      subject: 'Report',
      html: expect.stringContaining('<b>3 cheaters</b>'),
      headers: { 'X-Report': 'weekly' },
    })
  })

  it('tries a queued mail again when the transport fails, as often as `tries` says', async () => {
    let calls = 0
    const sent: string[] = []
    const flaky: MailTransport = {
      name: 'flaky',
      async send(message) {
        if (++calls < 3)
          throw new Error('421 try again later')
        sent.push(message.subject)
      },
    }
    const { api, queue, logger } = start({ from: 'game@example.com', tries: 3, backoffMs: 0 })
    api.useTransport(flaky)

    await api.to('a@example.com').send(new Welcome('A'))
    queue.start()

    await vi.waitFor(() => expect(sent).toEqual(['Welcome, A']))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('421 try again later'))
    expect(await queue.failed()).toEqual([])
  })

  it('throws when the mail can\'t be sent as it is, instead of queueing it', async () => {
    const { api, queue } = start({})
    api.useTransport(memoryTransport())

    await expect(api.to('nope').send(new Welcome('A'))).rejects.toThrow('is no address')
    await expect(api.to('a@example.com').send(new Welcome('A'))).rejects.toThrow('No sender: set "from"')
    expect(await queue.size()).toBe(0)
  })

  it('writes mail to the log until a transport is set up', async () => {
    const { api, logger } = start({})

    expect(api.transport).toBe('log')
    expect(logger.info).toHaveBeenCalledWith(expect.stringContaining('mail is written to the log'))
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('no sender set'))

    // The log needs no sender, and shows the words of the mail, not the layout's markup
    await api.send({ to: 'a@example.com', subject: 'Hi', html: '<p>Hello <b>you</b></p>' }, { queued: false })
    const logged = logger.info.mock.calls.map(([m]) => String(m)).find(m => m.startsWith('Mail (not sent'))!
    expect(logged.split('\n').slice(0, 2)).toEqual(['Mail (not sent: no mail transport is set up) to a@example.com: Hi', 'Hello you'])
    expect(logged).not.toContain('<')
    expect(logged).not.toContain('asset:publish')
  })

  it('closes the transport it replaces, and the last one when the server stops', async () => {
    const { api, ctx } = start()
    const first = {
      ...memoryTransport(),
      close: vi.fn(),
    }
    const second = {
      ...memoryTransport(),
      close: vi.fn(),
    }

    api.useTransport(first)
    api.useTransport(second)
    expect(first.close).toHaveBeenCalled()

    await plugin.destroy(ctx)
    expect(second.close).toHaveBeenCalled()
  })

  it('is found by the game with mail(server)', () => {
    const { api, server } = start()
    expect(mail(server)).toBe(api)
    expect(mail({})).toBeUndefined()
  })

  it('sends through nodemailer, e.g. its JSON transport', async () => {
    const { api } = start()
    api.useNodemailer({ jsonTransport: true }, 'json')

    expect(api.transport).toBe('json')
    const result = await api.to('a@example.com').sendNow(new Welcome('A'))
    expect(result).toEqual({
      queued: false,
      transport: 'json',
      messageId: expect.stringContaining('@example.com>'),
    })
  })

  it('gives other plugins its api by type', () => {
    // Typed through ServerPluginApis: this only compiles with the right type
    const ctx = {
      plugin: () => undefined,
    } as unknown as ServerPluginContext
    const api: MailApi | undefined = ctx.plugin('@mavonengine/mail')
    expect(api).toBeUndefined()
  })
})

describe('mail options', () => {
  it('fills in the defaults, and keeps what makes sense', () => {
    expect(parseOptions({}, {})).toEqual({
      queued: true,
      queue: 'default',
      tries: 3,
      backoffMs: [10_000, 60_000],
      layout: true,
      layoutData: {},
      devInbox: true,
    })
    expect(parseOptions({
      queued: false,
      queue: 'mail',
      tries: 5.7,
      backoffMs: 500,
      from: 'a@example.com',
      smtp: { host: 'smtp.example.com' },
    }, {}))
      .toEqual({
        queued: false,
        queue: 'mail',
        tries: 5,
        backoffMs: 500,
        from: 'a@example.com',
        smtp: { host: 'smtp.example.com' },
        layout: true,
        layoutData: {},
        devInbox: true,
      })
    expect(parseOptions({
      queued: 'yes',
      queue: '',
      tries: 0,
      backoffMs: ['x'],
      smtp: { port: 25 },
    }, {}))
      .toEqual({
        queued: true,
        queue: 'default',
        tries: 3,
        backoffMs: [10_000, 60_000],
        layout: true,
        layoutData: {},
        devInbox: true,
      })
  })

  it('wants the dev inbox in development only, unless it is turned off', () => {
    expect(parseOptions({}, {}).devInbox).toBe(true)
    expect(parseOptions({}, { NODE_ENV: 'development' }).devInbox).toBe(true)
    expect(parseOptions({}, { NODE_ENV: 'production' }).devInbox).toBe(false)
    expect(parseOptions({}, { NODE_ENV: 'test' }).devInbox).toBe(false)
    expect(parseOptions({ devInbox: false }, {}).devInbox).toBe(false)
  })

  it('takes the sender and the SMTP URL from the environment over the options', () => {
    const env = { [FROM_ENV]: 'env@example.com', [SMTP_URL_ENV]: 'smtps://u:p@smtp.example.com' }
    expect(parseOptions({
      from: 'a@example.com',
      smtp: { host: 'other' },
    }, env)).toMatchObject({ from: 'env@example.com', smtp: 'smtps://u:p@smtp.example.com' })
  })

  it('makes the SMTP config with the password from the environment', () => {
    const env = { [SMTP_PASSWORD_ENV]: 's3cret/+' }
    expect(smtpConfig({ host: 'smtp.example.com', user: 'game' }, env)).toEqual({
      host: 'smtp.example.com',
      port: 587,
      secure: false,
      auth: { user: 'game', pass: 's3cret/+' },
    })
    expect(smtpConfig({ host: 'smtp.example.com', port: 465 }, {})).toEqual({
      host: 'smtp.example.com',
      port: 465,
      secure: true,
      auth: undefined,
    })
    expect(smtpConfig({ host: 'smtp.example.com', secure: true }, {})).toMatchObject({ port: 465 })
    expect(smtpConfig('smtp://game@smtp.example.com:2525', env)).toBe('smtp://game:s3cret%2F+@smtp.example.com:2525')
    // A URL from the environment has its password already
    expect(smtpConfig('smtp://game:own@smtp.example.com', { ...env, [SMTP_URL_ENV]: 'smtp://game:own@smtp.example.com' })).toBe('smtp://game:own@smtp.example.com')
  })
})
