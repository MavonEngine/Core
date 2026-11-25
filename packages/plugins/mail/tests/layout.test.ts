import type { ServerPluginContext } from '@mavonengine/core/Plugins/types'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import Queue from '@mavonengine/core/Queue/Queue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import plugin, { DEFAULT_LAYOUT_PATH, escapeHtml, Mailable, memoryTransport, renderLayout, textToHtml } from '../src/index'
import { htmlToLogText } from '../src/transports'

class Welcome extends Mailable {
  constructor(private name: string) {
    super()
  }

  subject() {
    return `Welcome, ${this.name}`
  }

  html() {
    return `<p>Hi <b>${escapeHtml(this.name)}</b></p>`
  }

  preheader() {
    return 'Your account is ready'
  }
}

describe('renderLayout', () => {
  it('fills in values escaped with {{ }} and as they are with {{{ }}}, unknown ones empty', () => {
    expect(renderLayout('<h1>{{ title }}</h1>{{{ content }}}<i>{{nope}}</i>{{{nope}}}', { title: 'Tom & <Jerry>', content: '<p>ok</p>' }))
      .toBe('<h1>Tom &amp; &lt;Jerry&gt;</h1><p>ok</p><i></i>')
  })

  it('leaves comments out, apart from Outlook\'s conditional ones', () => {
    const layout = '<!-- {{{ content }}} goes below -->{{{ content }}}<!--[if mso]><b>{{ title }}</b><![endif]-->'
    expect(renderLayout(layout, { content: 'X', title: 'T' })).toBe('X<!--[if mso]><b>T</b><![endif]-->')
  })
})

describe('textToHtml', () => {
  it('makes paragraphs at blank lines and keeps line breaks, escaped', () => {
    expect(textToHtml('Hi <you>,\r\nwelcome.\n\n\nBye')).toBe('<p style="margin: 0 0 16px;">Hi &lt;you&gt;,<br>welcome.</p>\n<p style="margin: 0 0 16px;">Bye</p>')
  })
})

describe('escapeHtml', () => {
  it('escapes what HTML reads as markup', () => {
    expect(escapeHtml('<a href="x">\'&\'</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;')
  })
})

describe('the default layout', () => {
  it('has the mail\'s content once, outside its comment', () => {
    const layout = readFileSync(DEFAULT_LAYOUT_PATH, 'utf8')
    expect(layout).toContain('{{{ content }}}')
    const html = renderLayout(layout, {
      content: 'UNIQUE-CONTENT',
      subject: 'S',
      appName: 'Game',
      year: '2026',
    })
    expect(html.split('UNIQUE-CONTENT')).toHaveLength(2)
  })
})

describe('mail in the layout', () => {
  let dir: string
  const queues: Queue[] = []

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mavonengine-layout-'))
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await Promise.all(queues.splice(0).map(queue => queue.stop()))
    rmSync(dir, { recursive: true, force: true })
  })

  function start(options: Record<string, unknown> = {}, published?: string, appName?: string) {
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const queue = new Queue(logger)
    queues.push(queue)
    const ctx = {
      options: { from: 'Space Game <game@example.com>', queued: false, ...options },
      logger,
      server: {},
      queue,
      publishedFile: (path: string) => path === 'layout.html'
        ? published
        : undefined,
      appUrl: 'https://game.example.com',
      appName,
    } as unknown as ServerPluginContext
    const api = plugin.api(ctx)
    const memory = memoryTransport()
    api.useTransport(memory)
    return { api, memory, logger }
  }

  it('sends html in the plugin\'s layout, with the subject, preheader, game name and year', async () => {
    const { api, memory } = start({
      layoutData: { footer: 'You play Space Game & <friends>.' },
    })
    await api.to('a@example.com').send(new Welcome('<Ada>'))

    const html = memory.sent[0].html!
    expect(html).toMatch(/^<!doctype html>/)
    expect(html).toContain('<p>Hi <b>&lt;Ada&gt;</b></p>')
    expect(html).toContain('<title>Welcome, &lt;Ada&gt;</title>')
    expect(html).toContain('Your account is ready')
    expect(html).toContain('Space Game')
    expect(html).toContain(`&copy; ${new Date().getFullYear()} Space Game`)
    expect(html).toContain('You play Space Game &amp; &lt;friends&gt;.')
    // Neither placeholders nor the layout's own explanation end up in the mail
    expect(html).not.toContain('{{')
    expect(html).not.toContain('asset:publish')
    // The text a client without html shows is left alone
    expect(memory.sent[0].text).toBeUndefined()
  })

  it('takes the game\'s name, appName in mavonengine.json, over the sender\'s', async () => {
    const { api, memory } = start({}, undefined, 'Space Game Online')
    await api.send({ to: 'a@example.com', subject: 'Hi', text: 'Hello' })
    expect(memory.sent[0].html).toContain('&copy; 2026 Space Game Online'.replace('2026', String(new Date().getFullYear())))
  })

  it('leaves mail out of the layout when the mail, or the options, say so', async () => {
    class Plain extends Welcome {
      layout = false
    }
    const plain = start()
    await plain.api.to('a@example.com').send(new Plain('Ada'))
    await plain.api.send({
      to: 'a@example.com',
      subject: 'Hi',
      text: 'Only text',
      layout: false,
    })
    expect(plain.memory.sent[0].html).toBe('<p>Hi <b>Ada</b></p>')
    expect(plain.memory.sent[1]).not.toHaveProperty('html')

    const off = start({ layout: false })
    await off.api.to('a@example.com').send(new Welcome('Ada'))
    expect(off.memory.sent[0].html).toBe('<p>Hi <b>Ada</b></p>')
  })

  it('uses the project\'s published layout, read again while not in production', async () => {
    const file = join(dir, 'layout.html')
    writeFileSync(file, '<main>{{ appName }} ({{ appUrl }}): {{{ content }}}</main>')
    const { api, memory } = start({}, file)

    await api.to('a@example.com').send(new Welcome('Ada'))
    expect(memory.sent[0].html).toBe('<main>Space Game (https://game.example.com): <p>Hi <b>Ada</b></p></main>')

    writeFileSync(file, '<section>{{{ content }}}</section>')
    await api.to('a@example.com').send(new Welcome('Ada'))
    expect(memory.sent[1].html).toBe('<section><p>Hi <b>Ada</b></p></section>')
  })

  it('reads the layout once in production', async () => {
    vi.stubEnv('NODE_ENV', 'production')
    const file = join(dir, 'layout.html')
    writeFileSync(file, '<main>{{{ content }}}</main>')
    const { api, memory } = start({}, file)

    await api.to('a@example.com').send(new Welcome('Ada'))
    writeFileSync(file, '<section>{{{ content }}}</section>')
    await api.to('a@example.com').send(new Welcome('Ada'))

    expect(memory.sent.map(m => m.html)).toEqual(['<main><p>Hi <b>Ada</b></p></main>', '<main><p>Hi <b>Ada</b></p></main>'])
  })

  it('sends mail without a layout it can\'t read, and says so once', async () => {
    const { api, memory, logger } = start({}, join(dir, 'gone.html'))
    await api.to('a@example.com').send(new Welcome('Ada'))
    await api.to('a@example.com').send(new Welcome('Ada'))

    expect(memory.sent.map(m => m.html)).toEqual(['<p>Hi <b>Ada</b></p>', '<p>Hi <b>Ada</b></p>'])
    expect(logger.error.mock.calls.filter(([m]) => String(m).includes('could not read the layout'))).toHaveLength(1)
  })
})

describe('htmlToLogText', () => {
  it('keeps the words of a mail in the layout, without its head, comments and markup', () => {
    const html = renderLayout(readFileSync(DEFAULT_LAYOUT_PATH, 'utf8'), {
      content: '<p>Hello &amp; welcome</p><p>Bye</p>',
      subject: 'S',
      appName: 'Game',
      year: '2026',
    })
    expect(htmlToLogText(html)).toBe('Game\nHello & welcome\nBye\n© 2026 Game')
  })
})
