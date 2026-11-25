import type { ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { AddressInfo, Server, Socket } from 'node:net'
import { Buffer } from 'node:buffer'
import { createServer } from 'node:net'
import Queue from '@mavonengine/core/Queue/Queue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import plugin, { Mailable, SMTP_PASSWORD_ENV } from '../src/index'

interface Received {
  auth?: string
  from?: string
  to: string[]
  data?: string
}

/**
 * Just enough of an SMTP server to take one mail: no TLS, AUTH PLAIN only. What nodemailer sends ends up in `received`
 */
function fakeSmtp(): Promise<{ server: Server, port: number, received: Received[] }> {
  const received: Received[] = []
  const server = createServer((socket: Socket) => {
    let mail: Received = { to: [] }
    let inData = false
    let buffer = ''
    const reply = (line: string) => socket.write(`${line}\r\n`)
    reply('220 fake ESMTP')

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      while (true) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n')
          if (end < 0)
            return
          mail.data = buffer.slice(0, end)
          buffer = buffer.slice(end + 5)
          inData = false
          received.push(mail)
          mail = { to: [] }
          reply('250 queued as fake-1')
          continue
        }

        const newline = buffer.indexOf('\r\n')
        if (newline < 0)
          return
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 2)
        const command = line.slice(0, 4).toUpperCase()

        if (command === 'EHLO') {
          reply('250-fake\r\n250-AUTH PLAIN\r\n250 8BITMIME')
        }
        else if (command === 'AUTH') {
          mail.auth = Buffer.from(line.split(' ')[2], 'base64').toString('utf8')
          reply('235 accepted')
        }
        else if (command === 'MAIL') {
          mail.from = line.slice(line.indexOf('<') + 1, line.indexOf('>'))
          reply('250 ok')
        }
        else if (command === 'RCPT') {
          mail.to.push(line.slice(line.indexOf('<') + 1, line.indexOf('>')))
          reply('250 ok')
        }
        else if (command === 'DATA') {
          inData = true
          reply('354 go on')
        }
        else if (command === 'QUIT') {
          reply('221 bye')
          socket.end()
        }
        else {
          reply('250 ok')
        }
      }
    })
  })

  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve({ server, port: (server.address() as AddressInfo).port, received })))
}

class Reset extends Mailable {
  subject() {
    return 'Reset your password'
  }

  text() {
    return 'Use code 123456'
  }
}

const servers: Server[] = []

afterEach(async () => {
  vi.unstubAllEnvs()
  await Promise.all(servers.splice(0).map(server => new Promise(resolve => server.close(resolve))))
})

describe('mail over SMTP', () => {
  it('sends through the SMTP server from the options, logging in with the password from the environment', async () => {
    const smtp = await fakeSmtp()
    servers.push(smtp.server)
    vi.stubEnv(SMTP_PASSWORD_ENV, 'hunter22')

    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }
    const queue = new Queue(logger)
    const ctx = {
      options: {
        from: 'Game <game@example.com>',
        smtp: { host: '127.0.0.1', port: smtp.port, user: 'game' },
      },
      logger,
      server: {},
      queue,
    } as unknown as ServerPluginContext
    const api = plugin.api(ctx)
    plugin.setup(ctx)

    expect(api.transport).toBe('smtp')
    const result = await api.to('Player <player@example.com>').sendNow(new Reset())

    expect(result).toMatchObject({
      queued: false,
      transport: 'smtp',
      messageId: expect.stringContaining('@example.com>'),
    })
    expect(smtp.received).toHaveLength(1)
    const [mail] = smtp.received
    expect(mail.auth).toBe('\0game\0hunter22')
    expect(mail.from).toBe('game@example.com')
    expect(mail.to).toEqual(['player@example.com'])
    expect(mail.data).toContain('Subject: Reset your password')
    expect(mail.data).toContain('From: Game <game@example.com>')
    expect(mail.data).toContain('Use code 123456')
    expect(logger.info).toHaveBeenCalledWith('Mail sent through smtp to "Player" <player@example.com>: Reset your password')

    await plugin.destroy(ctx)
  })
})
