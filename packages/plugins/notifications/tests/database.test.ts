import type { ServerChannel } from '@geckos.io/server'
import type { LoadedPlugin, ServerPlugin } from '@mavonengine/core/Plugins/types'
import type GameObject from '@mavonengine/core/World/GameObject'
import type { Kysely } from 'kysely'
import type { NotificationsResult } from '../src/protocol'
import Server from '@mavonengine/core/Networking/Server/Server'
import { account, notifiable, notify } from '@mavonengine/core/Notifications/Notifiable'
import { afterEach, describe, expect, it, vi } from 'vitest'
import winston from 'winston'
import { LIST_MESSAGE, READ_MESSAGE, RESULT_MESSAGE, UNREAD_MESSAGE } from '../src/protocol'
import plugin, { MAX_DATA_CHARS, Notification, NOTIFICATION_MESSAGE, notifications } from '../src/server'
import { memoryDb } from './memoryDb'

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

class TestServer extends Server<GameObject> {
  getStateSyncDistance(): number {
    return 0
  }

  protected onCommand(): void {}

  protected onConnection(_channel: ServerChannel): GameObject {
    throw new Error('not used')
  }
}

class FriendRequest extends Notification {
  constructor(private from: string, private channels = ['database', 'game']) {
    super()
  }

  via() {
    return this.channels
  }

  toDatabase() {
    return { from: this.from }
  }

  toGame() {
    return { from: this.from }
  }
}

const TABLE = 'notifications_notifications'
const servers: TestServer[] = []

afterEach(async () => {
  await Promise.all(servers.splice(0).map(server => server.stop()))
})

async function start({ database = true, db: given, options = {} as Record<string, unknown> }: { database?: boolean, db?: Kysely<any>, options?: Record<string, unknown> } = {}) {
  const db = database
    ? given ?? memoryDb()
    : undefined
  const logger = winston.createLogger({ transports: [], silent: true })
  const loaded: LoadedPlugin<ServerPlugin>[] = [
    { package: '@mavonengine/notifications', options, plugin },
  ]
  if (db) {
    loaded.push({
      package: '@mavonengine/sqlite',
      options: {},
      plugin: {
        database: () => db,
      },
    })
  }

  const server = new TestServer(logger, undefined, { stopOnSignals: false, plugins: loaded })
  vi.spyOn(server.http, 'start').mockImplementation(() => {})
  // The database is the test's, closed by it
  if (db)
    vi.spyOn(db, 'destroy').mockResolvedValue(undefined)
  servers.push(server)
  await server.start()

  const connect = (accountId: string) => {
    const handlers = new Map<string, (data: unknown) => void>()
    const channel = {
      id: `ch-${Math.random()}`,
      userData: { id: accountId },
      emit: vi.fn(),
      on: vi.fn((event: string, callback: (data: unknown) => void) => void handlers.set(event, callback)),
      send: (event: string, data: unknown) => handlers.get(event)?.(data),
      /** The answers the server sent this game */
      results: () => channel.emit.mock.calls.filter(([event]) => event === RESULT_MESSAGE).map(([, result]) => result as NotificationsResult),
      unreadPushes: () => channel.emit.mock.calls.filter(([event]) => event === UNREAD_MESSAGE).map(([, body]) => (body as { unread: number }).unread),
    }
    server.plugins!.run('onConnection', channel as unknown as ServerChannel, {} as GameObject)
    return channel
  }

  return {
    server,
    db,
    logger,
    connect,
    api: notifications(server)!,
  }
}

describe('database channel', () => {
  it('migrates its table and keeps a notification for every recipient, the latest first', async () => {
    const { db, api } = await start()
    expect((await db!.introspection.getTables()).map(t => t.name)).toContain(TABLE)

    await notify([
      account('ada'),
      account('bob'),
    ], new FriendRequest('carol', ['database']))
    await new Promise(resolve => setTimeout(resolve, 2))
    await notify(account('ada'), new FriendRequest('dave', ['database']))

    const stored = await api.stored(account('ada'))
    expect(stored).toEqual([
      {
        id: expect.any(String),
        notificationId: expect.any(String),
        type: 'FriendRequest',
        data: { from: 'dave' },
        readAt: null,
        createdAt: expect.any(String),
      },
      expect.objectContaining({
        data: { from: 'carol' },
        readAt: null,
      }),
    ])
    const [bobs] = await api.stored(account('bob'))
    // One notify(), one notification id for every recipient, a row of its own each
    expect(bobs.notificationId).toBe(stored[1].notificationId)
    expect(bobs.id).not.toBe(stored[1].id)
    expect(await api.unreadCount(account('ada'))).toBe(2)
  })

  it('marks read by id, by the toast\'s id, or all, and forgets', async () => {
    const { api } = await start()
    await notify(account('ada'), new FriendRequest('a', ['database']))
    await notify(account('ada'), new FriendRequest('b', ['database']))
    await notify(account('ada'), new FriendRequest('c', ['database']))
    const [c, b, a] = await api.stored(account('ada'))

    expect(await api.markRead(account('ada'), [c.id])).toBe(1)
    expect(await api.markRead(account('ada'), [b.notificationId])).toBe(1)
    // Already read: not counted again
    expect(await api.markRead(account('ada'), [c.id])).toBe(0)
    expect(await api.markRead(account('bob'), [a.id])).toBe(0)
    expect((await api.stored(account('ada'), { unread: true })).map(n => n.id)).toEqual([a.id])

    expect(await api.markRead(account('ada'))).toBe(1)
    expect(await api.unreadCount(account('ada'))).toBe(0)
    expect((await api.stored(account('ada')))[0].readAt).toEqual(expect.any(String))

    expect(await api.forget(account('ada'), [a.id])).toBe(1)
    expect(await api.forget(account('ada'))).toBe(2)
    expect(await api.stored(account('ada'))).toEqual([])
  })

  it('keeps notifications of other recipients, like a guild, under their own type', async () => {
    const { api } = await start()
    class Guild extends notifiable() {
      readonly notifiableType = 'guild'
      notifiableId() {
        return 'ada'
      }
    }
    const guild = new Guild()
    await guild.notify(new FriendRequest('x', ['database']))

    expect(await api.stored(guild)).toHaveLength(1)
    // Same id, other type: not the account's
    expect(await api.stored(account('ada'))).toEqual([])
    await expect(api.stored({
      notifiableType: 'account',
      notifiableId: () => undefined,
    })).rejects.toThrow('has no id')
  })

  it('pages through what it kept', async () => {
    const { api } = await start()
    for (let i = 0; i < 5; i++)
      await notify(account('ada'), new FriendRequest(String(i), ['database']))

    expect(await api.stored(account('ada'), { limit: 2 })).toHaveLength(2)
    expect(await api.stored(account('ada'), { limit: 2, offset: 4 })).toHaveLength(1)
  })

  it('keeps it before the game shows it, and tells the account\'s games the unread count', async () => {
    const { connect } = await start()
    const tab = connect('ada')
    await vi.waitFor(() => expect(tab.unreadPushes()).toEqual([0]))

    await notify(account('ada'), new FriendRequest('carol'))

    const events = tab.emit.mock.calls.map(([event]) => event)
    expect(events).toEqual([UNREAD_MESSAGE, UNREAD_MESSAGE, NOTIFICATION_MESSAGE])
    expect(tab.unreadPushes()).toEqual([0, 1])
  })

  it('refuses data that can\'t be kept, before reaching anyone', async () => {
    const { connect } = await start()
    const tab = connect('ada')
    class Huge extends FriendRequest {
      toDatabase() {
        return {
          from: 'x'.repeat(MAX_DATA_CHARS),
        }
      }
    }
    await expect(notify(account('ada'), new Huge('x'))).rejects.toThrow('more than the')
    expect(tab.emit.mock.calls.filter(([event]) => event === NOTIFICATION_MESSAGE)).toEqual([])
  })

  it('deletes notifications read longer ago than keepReadDays when it starts', async () => {
    const db = memoryDb()
    const first = await start({ db })
    await notify(account('ada'), new FriendRequest('old', ['database']))
    await new Promise(resolve => setTimeout(resolve, 2))
    await notify(account('ada'), new FriendRequest('new', ['database']))
    const [, old] = await first.api.stored(account('ada'))
    await db.updateTable(TABLE).set({ read_at: '2020-01-01T00:00:00.000Z' }).where('id', '=', old.id).execute()
    await first.server.stop()

    const second = await start({
      db,
      options: { keepReadDays: 30 },
    })
    await vi.waitFor(async () => expect((await second.api.stored(account('ada'))).map(n => n.data)).toEqual([
      { from: 'new' },
    ]))
  })

  it('without a database, keeps nothing and says so once', async () => {
    const { server, connect, api } = await start({ database: false })
    const warn = vi.spyOn((server as unknown as { logger: winston.Logger }).logger, 'warn')
    const tab = connect('ada')

    await notify(account('ada'), new FriendRequest('a'))
    await notify(account('ada'), new FriendRequest('b'))

    expect(tab.emit.mock.calls.filter(([event]) => event === NOTIFICATION_MESSAGE)).toHaveLength(2)
    expect(warn.mock.calls.filter(([m]) => String(m).includes('no database plugin'))).toHaveLength(1)
    expect(await api.stored(account('ada'))).toEqual([])

    tab.send(LIST_MESSAGE, { requestId: 'r1' })
    expect(tab.results()).toEqual([
      {
        requestId: 'r1',
        unread: 0,
        error: expect.stringContaining('no database'),
      },
    ])
  })
})

describe('the player\'s game reading its notifications', () => {
  it('lists the account\'s notifications and marks them read, telling its other games', async () => {
    const { connect } = await start()
    const tab = connect('ada')
    const otherTab = connect('ada')
    const stranger = connect('bob')
    await notify(account('ada'), new FriendRequest('carol', ['database']))
    await notify(account('bob'), new FriendRequest('dave', ['database']))

    tab.send(LIST_MESSAGE, { requestId: 'r1', unread: true })
    await vi.waitFor(() => expect(tab.results()).toHaveLength(1))
    const [list] = tab.results()
    expect(list).toEqual({
      requestId: 'r1',
      notifications: [
        expect.objectContaining({
          data: { from: 'carol' },
        }),
      ],
      unread: 1,
    })

    tab.send(READ_MESSAGE, {
      requestId: 'r2',
      ids: [list.notifications![0].notificationId],
    })
    await vi.waitFor(() => expect(tab.results()).toHaveLength(2))
    expect(tab.results()[1]).toEqual({ requestId: 'r2', marked: 1, unread: 0 })
    await vi.waitFor(() => expect(otherTab.unreadPushes().at(-1)).toBe(0))

    // bob's games only ever see bob's
    stranger.send(LIST_MESSAGE, { requestId: 'r3' })
    await vi.waitFor(() => expect(stranger.results()).toHaveLength(1))
    expect(stranger.results()[0].notifications!.map(n => n.data)).toEqual([
      { from: 'dave' },
    ])
  })

  it('answers only requests that are asked for well', async () => {
    const { connect } = await start()
    const tab = connect('ada')

    for (const bad of [
      null,
      'x',
      {},
      { requestId: '' },
      {
        requestId: 'x'.repeat(65),
      },
      { requestId: 5 },
    ])
      tab.send(LIST_MESSAGE, bad)
    tab.send(READ_MESSAGE, { requestId: 'r1', ids: 'all' })
    tab.send(READ_MESSAGE, {
      requestId: 'r2',
      ids: Array.from({ length: 101 }, (_, i) => `id-${i}`),
    })
    tab.send(LIST_MESSAGE, { requestId: 'r3', limit: 10_000 })

    await vi.waitFor(() => expect(tab.results()).toHaveLength(3))
    expect(tab.results()).toEqual([
      {
        requestId: 'r1',
        unread: 0,
        error: expect.stringContaining('ids must be'),
      },
      {
        requestId: 'r2',
        unread: 0,
        error: expect.stringContaining('ids must be'),
      },
      { requestId: 'r3', notifications: [], unread: 0 },
    ])
  })
})
