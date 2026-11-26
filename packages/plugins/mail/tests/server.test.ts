import type { ServerChannel } from '@geckos.io/server'
import type { ServerPlugin } from '@mavonengine/core/Plugins/types'
import type GameObject from '@mavonengine/core/World/GameObject'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import Server from '@mavonengine/core/Networking/Server/Server'
import { readPluginManifest } from '@mavonengine/core/Plugins/ProjectConfig'
import { publishFiles } from '@mavonengine/core/Plugins/publish'
import { describe, expect, it, vi } from 'vitest'
import winston from 'winston'
import mailPlugin, { mail, Mailable, memoryTransport } from '../src/index'

vi.mock('@geckos.io/server', () => ({
  default: vi.fn(() => ({
    onConnection: vi.fn(),
    connectionsManager: {
      connections: new Map(),
    },
    emit: vi.fn(),
    listen: vi.fn(),
  })),
}))

// No client connects in these tests
class TestServer extends Server<GameObject> {
  getStateSyncDistance(): number {
    return 0
  }

  protected onCommand(): void {}

  protected onConnection(_channel: ServerChannel): GameObject {
    throw new Error('No client connects in these tests')
  }
}

class Welcome extends Mailable {
  subject() {
    return 'Welcome'
  }

  text() {
    return 'Hi'
  }
}

describe('mail plugin on a game server', () => {
  it('sends mail another plugin queues in its setup(), whatever order they load in, through the server\'s queue', async () => {
    const memory = memoryTransport()
    const shop: ServerPlugin = {
      setup(ctx) {
        // Typed through ServerPluginApis: MailApi | undefined
        const api = ctx.plugin('@mavonengine/mail')
        api?.useTransport(memory)
        void api?.to('buyer@example.com').send(new Welcome())
      },
    }

    const logger = winston.createLogger({ transports: [], silent: true })
    const server = new TestServer(logger, undefined, {
      stopOnSignals: false,
      queue: { pollIntervalMs: 10 },
      plugins: [
        { package: 'shop', options: {}, plugin: shop },
        {
          package: '@mavonengine/mail',
          options: { from: 'shop@example.com' },
          plugin: mailPlugin,
        },
      ],
    })
    vi.spyOn(server.http, 'start').mockImplementation(() => {})
    await server.start()

    await vi.waitFor(() => expect(memory.sent.map(m => m.to[0].address)).toEqual(['buyer@example.com']))
    expect(mail(server)?.transport).toBe('memory')

    await server.stop()
    expect(mail(server)).toBeUndefined()
  })

  it('sends mail in the layout the project published and changed', async () => {
    const project = mkdtempSync(join(tmpdir(), 'mavonengine-mail-project-'))
    try {
      // What `mavonengine asset:publish @mavonengine/mail` does, with this package as it is installed
      const repo = fileURLToPath(new URL('../../../..', import.meta.url))
      const [layout] = publishFiles(project, readPluginManifest(repo, '@mavonengine/mail')!)
      expect(layout).toMatchObject({ path: 'layout.html', status: 'published' })
      expect(readFileSync(layout.to, 'utf8')).toContain('{{{ content }}}')
      writeFileSync(layout.to, '<html><body class="mine">{{{ content }}}</body></html>')

      const memory = memoryTransport()
      const logger = winston.createLogger({ transports: [], silent: true })
      const server = new TestServer(logger, undefined, {
        stopOnSignals: false,
        root: project,
        plugins: [
          {
            package: '@mavonengine/mail',
            options: { from: 'game@example.com', queued: false },
            plugin: mailPlugin,
          },
        ],
      })
      vi.spyOn(server.http, 'start').mockImplementation(() => {})
      await server.start()
      mail(server)!.useTransport(memory)

      await mail(server)!.to('a@example.com').send(new Welcome())
      expect(memory.sent[0].html).toBe('<html><body class="mine"><p style="margin: 0 0 16px;">Hi</p></body></html>')
      await server.stop()
    }
    finally {
      rmSync(project, { recursive: true, force: true })
    }
  })
})
