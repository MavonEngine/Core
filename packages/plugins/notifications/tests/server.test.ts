import type { ServerChannel } from '@geckos.io/server'
import type { LoadedPlugin, Notifiable, ServerPlugin } from '@mavonengine/core/Plugins/types'
import type GameObject from '@mavonengine/core/World/GameObject'
import type { Delivery } from '../src/server'
import Server from '@mavonengine/core/Networking/Server/Server'
import { account, notifiable, notify } from '@mavonengine/core/Notifications/Notifiable'
import mailPlugin, { mail, memoryTransport } from '@mavonengine/mail'
import { afterEach, describe, expect, it, vi } from 'vitest'
import winston from 'winston'
import plugin, { Notification, NOTIFICATION_MESSAGE, notifications, parseOptions } from '../src/server'

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

// No client connects through geckos in these tests: connections are handed to the plugins directly
class TestServer extends Server<GameObject> {
  getStateSyncDistance(): number {
    return 0
  }

  protected onCommand(): void {}

  protected onConnection(_channel: ServerChannel): GameObject {
    throw new Error('not used')
  }
}

class LevelUp extends Notification {
  constructor(private level: number, private channels = ['game', 'mail']) {
    super()
  }

  via() {
    return this.channels
  }

  toGame() {
    return { level: this.level }
  }

  toMail() {
    return { subject: `Level ${this.level}!`, text: `You reached level ${this.level}.` }
  }
}

const accounts: Record<string, { email: string | null, emailVerifiedAt: string | null }> = {
  'acc-1': { email: 'ada@example.com', emailVerifiedAt: '2026-01-01T00:00:00.000Z' },
  'acc-2': { email: 'bob@example.com', emailVerifiedAt: null },
  'acc-3': { email: null, emailVerifiedAt: null },
}

/** Stands in for @mavonengine/auth: only the api the mail channel uses */
const fakeAuth: ServerPlugin = {
  api: () => ({
    account: async (id: string) => accounts[id],
  }),
}

const servers: TestServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()))
})

async function start({ options = {}, withMail = true, withAuth = true, extra = [] as LoadedPlugin<ServerPlugin>[] } = {}) {
  const logger = winston.createLogger({ transports: [], silent: true })
  const memory = memoryTransport()
  const loaded: LoadedPlugin<ServerPlugin>[] = [
    { package: '@mavonengine/notifications', options, plugin },
    ...extra,
  ]
  if (withMail) {
    loaded.push({
      package: '@mavonengine/mail',
      options: { from: 'game@example.com', queued: false },
      plugin: {
        ...mailPlugin,
        setup(ctx) {
          mailPlugin.setup(ctx)
          ctx.plugin('@mavonengine/mail')!.useTransport(memory)
        },
      },
    })
  }
  if (withAuth)
    loaded.push({ package: '@mavonengine/auth', options: {}, plugin: fakeAuth })

  const server = new TestServer(logger, undefined, {
    stopOnSignals: false,
    plugins: loaded,
    queue: { pollIntervalMs: 10 },
  })
  vi.spyOn(server.http, 'start').mockImplementation(() => {})
  servers.push(server)
  await server.start()

  const connect = (accountId?: string) => {
    const handlers = new Map<string, (data: unknown) => void>()
    const channel = {
      id: `ch-${Math.random()}`,
      userData: accountId
        ? { id: accountId }
        : undefined,
      emit: vi.fn(),
      on: vi.fn((event: string, callback: (data: unknown) => void) => void handlers.set(event, callback)),
      /** A message from the player's game */
      send: (event: string, data: unknown) => handlers.get(event)?.(data),
    }
    server.plugins!.run('onConnection', channel as unknown as ServerChannel, {} as GameObject)
    return channel
  }
  const disconnect = (channel: ReturnType<typeof connect>) => server.plugins!.run('onDisconnect', channel as unknown as ServerChannel)
  return {
    server,
    memory,
    logger,
    connect,
    disconnect,
  }
}

class BaseGuild {
  constructor(readonly members: string[], readonly officers: string[]) {}
}

class Guild extends notifiable(BaseGuild) {
  readonly notifiableType = 'guild'
  notifiableId() {
    return 'guild-7'
  }

  routeNotificationFor(channel: string) {
    return channel === 'game'
      ? this.members
      : channel === 'mail'
        ? this.officers
        : undefined
  }
}

describe('notifications plugin', () => {
  it('sends to every open game connection of the account, and mails its address', async () => {
    const { memory, connect } = await start()
    const tab1 = connect('acc-1')
    const tab2 = connect('acc-1')
    const other = connect('acc-2')

    await notify(account('acc-1'), new LevelUp(5))

    for (const tab of [tab1, tab2]) {
      expect(tab.emit).toHaveBeenCalledWith(NOTIFICATION_MESSAGE, {
        id: expect.any(String),
        type: 'LevelUp',
        data: { level: 5 },
        sentAt: expect.any(String),
      }, { reliable: true })
    }
    expect(other.emit).not.toHaveBeenCalled()
    expect(memory.sent).toEqual([
      expect.objectContaining({
        to: [
          { address: 'ada@example.com' },
        ],
        subject: 'Level 5!',
        text: 'You reached level 5.',
      }),
    ])
    // One notification: the same id on every channel
    expect(tab1.emit.mock.calls[0][1].id).toBe(tab2.emit.mock.calls[0][1].id)
  })

  it('stops sending to a connection once it disconnected', async () => {
    const { connect, disconnect } = await start()
    const tab = connect('acc-1')
    disconnect(tab)

    await notify(account('acc-1'), new LevelUp(2, ['game']))
    expect(tab.emit).not.toHaveBeenCalled()
  })

  it('goes where the recipient routes it: a guild to its members\' games and its officers\' mail', async () => {
    const { memory, connect } = await start()
    const member = connect('acc-2')
    const outsider = connect('acc-1')

    await new Guild(['acc-2', 'acc-3'], ['officer@example.com']).notify(new LevelUp(9))

    expect(member.emit).toHaveBeenCalledWith(NOTIFICATION_MESSAGE, expect.objectContaining({
      data: { level: 9 },
    }), { reliable: true })
    expect(outsider.emit).not.toHaveBeenCalled()
    expect(memory.sent.map(m => m.to)).toEqual([
      [
        { address: 'officer@example.com' },
      ],
    ])
  })

  it('skips the mail of accounts without an address, or without a confirmed one when told to', async () => {
    const plain = await start()
    await notify([
      account('acc-2'),
      account('acc-3'),
    ], new LevelUp(1, ['mail']))
    expect(plain.memory.sent.map(m => m.to[0].address)).toEqual(['bob@example.com'])

    const verified = await start({
      options: { verifiedEmailOnly: true },
    })
    await notify([
      account('acc-1'),
      account('acc-2'),
    ], new LevelUp(1, ['mail']))
    expect(verified.memory.sent.map(m => m.to[0].address)).toEqual(['ada@example.com'])
  })

  it('leaves the mail to the mail plugin, which queues it unless the notification says not to', async () => {
    // The mail plugin with its default: queued
    const { server } = await start({
      withMail: false,
      extra: [
        {
          package: '@mavonengine/mail',
          options: { from: 'game@example.com' },
          plugin: mailPlugin,
        },
      ],
    })
    await server.queue.stop()
    const memory = memoryTransport()
    mail(server)!.useTransport(memory)

    await notify(account('acc-1'), new LevelUp(3, ['mail']))
    expect(memory.sent).toEqual([])
    expect(await server.queue.size()).toBe(1)

    server.queue.start()
    await vi.waitFor(() => expect(memory.sent).toHaveLength(1))

    class Urgent extends LevelUp {
      queued = false
    }
    const before = memory.sent.length
    await notify(account('acc-1'), new Urgent(4, ['mail']))
    // Sent in the call: no waiting on the queue
    expect(memory.sent).toHaveLength(before + 1)
  })

  it('throws for a channel without its to<Channel>(), or one that doesn\'t exist, before reaching anyone', async () => {
    const { connect } = await start()
    const tab = connect('acc-1')

    class GameOnly extends Notification {
      via() {
        return ['game', 'sms']
      }

      toGame() {
        return {}
      }
    }
    await expect(notify(account('acc-1'), new GameOnly())).rejects.toThrow('goes to the sms channel, which doesn\'t exist')

    class NoMail extends Notification {
      via() {
        return ['game', 'mail']
      }

      toGame() {
        return {}
      }
    }
    await expect(notify(account('acc-1'), new NoMail())).rejects.toThrow('NoMail goes to the mail channel, but has no toMail()')
    expect(tab.emit).not.toHaveBeenCalled()
  })

  it('skips recipients without an id, like a player without an account', async () => {
    const { connect } = await start()
    const tab = connect('acc-1')
    const nobody: Notifiable = {
      notifiableType: 'account',
      notifiableId: () => undefined,
    }

    await notify([
      nobody,
      account('acc-1'),
    ], new LevelUp(1, ['game']))
    expect(tab.emit).toHaveBeenCalledTimes(1)
  })

  it('still notifies in the game without the mail or auth plugin, and says once that it can\'t mail', async () => {
    const { connect, server } = await start({ withMail: false, withAuth: false })
    const warn = vi.spyOn((server as unknown as { logger: winston.Logger }).logger, 'warn')
    const tab = connect('acc-1')

    await notify(account('acc-1'), new LevelUp(1))
    await notify(account('acc-1'), new LevelUp(2))
    await new Guild([], ['officer@example.com']).notify(new LevelUp(3, ['mail']))

    expect(tab.emit).toHaveBeenCalledTimes(2)
    const warnings = warn.mock.calls.map(([message]) => String(message))
    expect(warnings.filter(w => w.includes('needs the auth plugin'))).toHaveLength(1)
    expect(warnings.filter(w => w.includes('no mail plugin'))).toHaveLength(1)
  })

  it('takes channels of its own, queued ones retried on the server\'s queue', async () => {
    const { server } = await start({
      options: { tries: 3, backoffMs: 0 },
    })
    const sent: Delivery[] = []
    let failures = 1
    const api = notifications(server)!
    api.channel('discord', {
      queued: true,
      route: () => 'webhook-1',
      send(delivery) {
        if (failures-- > 0)
          throw new Error('discord is down')
        sent.push(delivery)
      },
    })

    class Raid extends Notification {
      via() {
        return ['discord']
      }

      toDiscord() {
        return { content: 'Raid in 10 minutes' }
      }
    }

    await api.send(account('acc-1'), new Raid())
    expect(sent).toEqual([])
    expect(await server.queue.size()).toBe(1)

    await vi.waitFor(() => expect(sent).toHaveLength(1))
    expect(sent[0]).toMatchObject({
      channel: 'discord',
      type: 'Raid',
      route: 'webhook-1',
      recipient: { type: 'account', id: 'acc-1' },
      payload: { content: 'Raid in 10 minutes' },
    })
  })

  it('names a notification by its notificationType when it sets one', async () => {
    const { connect } = await start()
    const tab = connect('acc-1')
    class Named extends LevelUp {
      static notificationType = 'level-up'
    }
    await notify(account('acc-1'), new Named(1, ['game']))
    expect(tab.emit.mock.calls[0][1].type).toBe('level-up')
  })

  it('is the server\'s notifications plugin', async () => {
    const { server } = await start()
    expect(server.notificationsProvider).toBe('@mavonengine/notifications')
  })
})

describe('notifications options', () => {
  it('fills in the defaults', () => {
    expect(parseOptions({})).toEqual({
      verifiedEmailOnly: false,
      tries: 3,
      backoffMs: [10_000, 60_000],
      keepReadDays: 90,
    })
    expect(parseOptions({
      verifiedEmailOnly: true,
      tries: 5,
      backoffMs: 100,
      keepReadDays: 0,
    })).toEqual({
      verifiedEmailOnly: true,
      tries: 5,
      backoffMs: 100,
      keepReadDays: 0,
    })
    expect(parseOptions({
      verifiedEmailOnly: 'yes',
      tries: 0,
      backoffMs: ['x'],
      keepReadDays: -1,
    })).toEqual({
      verifiedEmailOnly: false,
      tries: 3,
      backoffMs: [10_000, 60_000],
      keepReadDays: 90,
    })
  })
})
