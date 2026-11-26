import type { ServerChannel } from '@geckos.io/server'
import type { Kysely } from 'kysely'
import type { ServerPlugin } from '../../src/Plugins/types'
import { describe, expect, it, vi } from 'vitest'
import winston from 'winston'
import Player from '../../src/Networking/Entities/Player'
import Server from '../../src/Networking/Server/Server'
import { memoryDb } from '../Plugins/Database/memoryDb'

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

class TestClient extends Player {
  update(_delta: number): void { }
  updateFromNetwork(_data: object): void { }
}

class TestServer extends Server<TestClient> {
  getStateSyncDistance(): number {
    return 0
  }

  protected onCommand(_command: any, _delta: number): void { }

  protected onConnection(channel: ServerChannel): TestClient {
    return new TestClient(channel.id)
  }
}

function sqlite(db: Kysely<any>): ServerPlugin {
  return {
    name: 'sqlite',
    database: () => db,
  }
}

describe('server plugin apis', () => {
  const logger = winston.createLogger({ transports: [], silent: true })

  interface MailApi {
    transport(name: string, send: (to: string) => void): void
    send(to: string): void
  }

  function mailPlugin(): ServerPlugin {
    const transports = new Map<string, (to: string) => void>()
    return {
      api: () => ({
        transport: (name, send) => void transports.set(name, send),
        send: to => transports.get('ses')?.(to),
      } satisfies MailApi),
    }
  }

  it('lets a plugin use another\'s api in setup(), also when it loads first', async () => {
    const sent: string[] = []
    let mail: MailApi | undefined
    const server = new TestServer(logger, undefined, {
      stopOnSignals: false,
      plugins: [
        {
          package: '@mavonengine/ses',
          options: {},
          plugin: {
            setup: ctx => ctx.plugin<MailApi>('@mavonengine/mail')?.transport('ses', to => void sent.push(to)),
          },
        },
        {
          package: '@mavonengine/mail',
          options: {},
          plugin: mailPlugin(),
        },
        {
          package: 'game',
          options: {},
          plugin: {
            setup: (ctx) => {
              mail = ctx.plugin<MailApi>('@mavonengine/mail')
            },
          },
        },
      ],
    })
    vi.spyOn(server.http, 'start').mockImplementation(() => {})
    await server.start()

    mail!.send('player@example.com')

    expect(sent).toEqual(['player@example.com'])
    expect(server.plugins!.api('@mavonengine/ses')).toBeUndefined()
    await server.stop()
  })

  it('has no api for a plugin its migration turned off', async () => {
    const db = memoryDb()
    let found: unknown = 'not asked'
    const server = new TestServer(logger, undefined, {
      stopOnSignals: false,
      plugins: [
        sqlite(db),
        {
          package: '@mavonengine/mail',
          options: {},
          plugin: {
            ...mailPlugin(),
            migrations: {
              '001': {
                up: async () => { throw new Error('nope') },
              },
            },
          },
        },
        {
          package: 'game',
          options: {},
          plugin: {
            setup: (ctx) => {
              found = ctx.plugin('@mavonengine/mail')
            },
          },
        },
      ],
    })
    vi.spyOn(server.http, 'start').mockImplementation(() => {})
    await server.start()

    expect(found).toBeUndefined()
    await server.stop()
  })
})
