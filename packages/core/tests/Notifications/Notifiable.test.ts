import type { ServerChannel } from '@geckos.io/server'
import type { Notifiable, NotificationLike } from '../../src/Notifications/Notifiable'
import type { ServerPlugin } from '../../src/Plugins/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import winston from 'winston'
import Player from '../../src/Networking/Entities/Player'
import Server from '../../src/Networking/Server/Server'
import { account, currentNotifier, notifiable, notify, resetNotifyWarning, setNotifier } from '../../src/Notifications/Notifiable'

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

class TestPlayer extends Player {
  update(_delta: number): void { }
  updateFromNetwork(_data: object): void { }
}

class TestServer extends Server<TestPlayer> {
  getStateSyncDistance(): number {
    return 0
  }

  protected onCommand(_command: any, _delta: number): void { }

  protected onConnection(channel: ServerChannel): TestPlayer {
    return new TestPlayer(channel.id)
  }
}

const levelUp: NotificationLike = {
  via: () => ['game'],
}

class BaseGuild {
  constructor(readonly id: string) {}
}

class Guild extends notifiable(BaseGuild) {
  readonly notifiableType = 'guild'
  notifiableId() {
    return this.id
  }
}

afterEach(() => {
  setNotifier(undefined)
  resetNotifyWarning()
  vi.restoreAllMocks()
})

describe('notify', () => {
  it('sends through the process\'s notifier, to one recipient or several', async () => {
    const sent: { to: string[], notification: NotificationLike }[] = []
    setNotifier(async (to, notification) => void sent.push({
      to: to.map(r => `${r.notifiableType}:${r.notifiableId()}`),
      notification,
    }))

    await notify(account('a1'), levelUp)
    await notify([
      new Guild('g1'),
      account('a2'),
    ], levelUp)

    expect(sent).toEqual([
      {
        to: ['account:a1'],
        notification: levelUp,
      },
      {
        to: ['guild:g1', 'account:a2'],
        notification: levelUp,
      },
    ])
  })

  it('sends nothing without a notifier, and says so once', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    await notify(account('a1'), levelUp)
    await notify(account('a1'), levelUp)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('@mavonengine/notifications')
  })

  it('gives a class notify() with notifiable(), also without a base class', async () => {
    const to: Notifiable[] = []
    setNotifier(async recipients => void to.push(...recipients))

    class Team extends notifiable() {
      readonly notifiableType = 'team'
      notifiableId() {
        return 'red'
      }
    }

    const guild = new Guild('g1')
    await guild.notify(levelUp)
    await new Team().notify(levelUp)

    expect(guild).toBeInstanceOf(BaseGuild)
    expect(guild.id).toBe('g1')
    expect(to.map(r => r.notifiableId())).toEqual(['g1', 'red'])
  })

  it('makes a player notifiable as its account', async () => {
    const to: Notifiable[] = []
    setNotifier(async recipients => void to.push(...recipients))

    const player = new TestPlayer('channel-1')
    expect(player.notifiableType).toBe('account')
    expect(player.notifiableId()).toBeUndefined()

    player.channel = {
      userData: { id: 'acc-1', name: 'Ada' },
    } as unknown as ServerChannel
    expect(player.notifiableId()).toBe('acc-1')

    await player.notify(levelUp)
    expect(to).toEqual([player])
  })
})

describe('server notifications', () => {
  let logger: winston.Logger

  beforeEach(() => {
    logger = winston.createLogger({ transports: [], silent: true })
  })

  function startable(server: TestServer) {
    vi.spyOn(server.http, 'start').mockImplementation(() => {})
    return server
  }

  it('sends notify() through the notifications plugin, with its context', async () => {
    const calls: unknown[][] = []
    const plugin: ServerPlugin = {
      notify: (to, notification, ctx) => void calls.push([to, notification, ctx.package]),
    }
    const server = startable(new TestServer(logger, undefined, {
      stopOnSignals: false,
      plugins: [
        { package: '@mavonengine/notifications', options: {}, plugin },
      ],
    }))
    await server.start()

    await notify(account('a1'), levelUp)

    expect(calls).toEqual([
      [
        [
          expect.objectContaining({ notifiableType: 'account' }),
        ],
        levelUp,
        '@mavonengine/notifications',
      ],
    ])
    expect(server.notificationsProvider).toBe('@mavonengine/notifications')
    expect(server.pluginInfos().find(info => info.package === '@mavonengine/notifications')?.notifications).toBe(true)
    await server.stop()
    expect(currentNotifier()).toBeUndefined()
  })

  it('passes a failure on to whoever called notify(), and keeps sending', async () => {
    let fail = true
    const plugin: ServerPlugin = {
      notify: async () => {
        if (fail)
          throw new Error('no route')
      },
    }
    const server = startable(new TestServer(logger, undefined, {
      stopOnSignals: false,
      plugins: [
        { package: 'n', options: {}, plugin },
      ],
    }))
    await server.start()

    await expect(notify(account('a1'), levelUp)).rejects.toThrow('no route')
    fail = false
    await expect(notify(account('a1'), levelUp)).resolves.toBeUndefined()
    await server.stop()
  })

  it('logs once that nothing is sent without a notifications plugin', async () => {
    const warn = vi.spyOn(logger, 'warn')
    const server = startable(new TestServer(logger, undefined, { stopOnSignals: false, plugins: [] }))
    await server.start()

    await notify(account('a1'), levelUp)
    await notify(account('a1'), levelUp)

    expect(warn.mock.calls.filter(([message]) => String(message).includes('no notifications plugin'))).toHaveLength(1)
    await server.stop()
  })

  it('picks the notifications plugin from the options', async () => {
    const a = vi.fn()
    const b = vi.fn()
    const server = startable(new TestServer(logger, undefined, {
      stopOnSignals: false,
      notifications: 'b',
      plugins: [
        {
          package: 'a',
          options: {},
          plugin: { notify: a },
        },
        {
          package: 'b',
          options: {},
          plugin: { notify: b },
        },
      ],
    }))
    await server.start()

    await notify(account('a1'), levelUp)

    expect(a).not.toHaveBeenCalled()
    expect(b).toHaveBeenCalled()
    await server.stop()
  })

  it('leaves the notifier of a server started later alone when it stops', async () => {
    const first = startable(new TestServer(logger, undefined, { stopOnSignals: false, plugins: [] }))
    await first.start()
    const second = startable(new TestServer(logger, undefined, { stopOnSignals: false, plugins: [] }))
    await second.start()
    const secondNotifier = currentNotifier()

    await first.stop()
    expect(currentNotifier()).toBe(secondNotifier)
    await second.stop()
    expect(currentNotifier()).toBeUndefined()
  })
})
