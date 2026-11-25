import type { ClientPluginContext } from '@mavonengine/core/Plugins/types'
import type { GameNotification } from '../src/client'
import { describe, expect, it, vi } from 'vitest'
import plugin, { NOTIFICATION_EVENT, NOTIFICATION_MESSAGE, notifications, REQUEST_TIMEOUT_MS, UNREAD_EVENT } from '../src/client'
import { LIST_MESSAGE, READ_MESSAGE, RESULT_MESSAGE, UNREAD_MESSAGE } from '../src/protocol'

function fakeGame() {
  const handlers = new Map<string, (data: unknown) => void>()
  const socket = {
    on: vi.fn((event: string, callback: (data: unknown) => void) => void handlers.set(event, callback)),
    emit: vi.fn(),
  }
  const game = {
    trigger: vi.fn(),
    network: undefined as { socket: typeof socket } | undefined,
  }
  const logger = {
    error: vi.fn(),
  }
  const ctx = { game, logger } as unknown as ClientPluginContext
  return {
    game,
    ctx,
    logger,
    connect: () => (game.network = { socket }),
    receive: (data: unknown) => handlers.get(NOTIFICATION_MESSAGE)!(data),
    /** A message from the server, of any kind */
    server: (event: string, data: unknown) => handlers.get(event)!(data),
    /** The last request the game sent */
    lastRequest: () => socket.emit.mock.lastCall as [string, { requestId: string }, unknown],
    socket,
  }
}

const levelUp: GameNotification = {
  id: 'n1',
  type: 'LevelUp',
  data: { level: 5 },
  sentAt: '2026-11-19T12:00:00.000Z',
}

describe('notifications in the browser', () => {
  it('listens once the game connected, and tells the listeners and the game', () => {
    const { game, ctx, connect, receive, socket } = fakeGame()
    const seen: GameNotification[] = []
    const levels: unknown[] = []
    const api = plugin.api!(ctx) as ReturnType<typeof notifications>
    api.on(n => void seen.push(n))
    api.onType<{ level: number }>('LevelUp', n => void levels.push(n.data.level))
    api.onType('Other', () => levels.push('wrong'))

    plugin.update!(0.016, ctx)
    expect(socket.on).not.toHaveBeenCalled()
    connect()
    plugin.update!(0.016, ctx)
    plugin.update!(0.016, ctx)
    // Hooked up once, not again on every frame
    expect(socket.on).toHaveBeenCalledTimes(3)

    receive(levelUp)

    expect(seen).toEqual([levelUp])
    expect(levels).toEqual([5])
    expect(game.trigger).toHaveBeenCalledWith(NOTIFICATION_EVENT, levelUp)
    // The game finds the same api
    expect(notifications(game)).toBe(api)
  })

  it('stops a listener, ignores what is no notification, and keeps going when a listener throws', () => {
    const { ctx, connect, receive, logger } = fakeGame()
    const api = notifications(ctx.game)
    const seen: string[] = []
    const stop = api.on(n => void seen.push(n.id))
    api.on(() => {
      throw new Error('toast broke')
    })
    connect()
    plugin.update!(0.016, ctx)

    receive({ nope: true })
    receive(levelUp)
    stop()
    receive({ ...levelUp, id: 'n2' })

    expect(seen).toEqual(['n1'])
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('toast broke'))
  })
})

describe('stored notifications in the browser', () => {
  function connected() {
    const fake = fakeGame()
    fake.connect()
    plugin.update!(0.016, fake.ctx)
    return {
      ...fake,
      api: notifications(fake.ctx.game),
    }
  }

  const stored = {
    id: 's1',
    notificationId: 'n1',
    type: 'FriendRequest',
    data: { from: 'carol' },
    readAt: null,
    createdAt: '2026-11-19T12:00:00.000Z',
  }

  it('asks the server for the account\'s notifications, and marks them read', async () => {
    const { api, server, lastRequest } = connected()

    const listing = api.stored({ unread: true, limit: 10 })
    const [event, body, options] = lastRequest()
    expect([event, body, options]).toEqual([
      LIST_MESSAGE,
      {
        requestId: expect.any(String),
        unread: true,
        limit: 10,
      },
      { reliable: true },
    ])
    server(RESULT_MESSAGE, {
      requestId: body.requestId,
      notifications: [stored],
      unread: 1,
    })
    expect(await listing).toEqual({
      notifications: [stored],
      unread: 1,
    })

    const marking = api.markRead(['n1'])
    const [readEvent, readBody] = lastRequest()
    expect([readEvent, readBody]).toEqual([
      READ_MESSAGE,
      {
        requestId: expect.any(String),
        ids: ['n1'],
      },
    ])
    expect(readBody.requestId).not.toBe(body.requestId)
    server(RESULT_MESSAGE, { requestId: readBody.requestId, marked: 1, unread: 0 })
    expect(await marking).toEqual({ marked: 1, unread: 0 })

    // Without ids: all of them
    void api.markRead()
    expect(lastRequest()[1]).toEqual({
      requestId: expect.any(String),
    })
  })

  it('keeps the unread count the server tells, for a badge', async () => {
    const { api, server, game, lastRequest } = connected()
    const counts: number[] = []
    const stop = api.onUnread(n => void counts.push(n))
    expect(api.unread).toBeUndefined()

    server(UNREAD_MESSAGE, { unread: 3 })
    server(UNREAD_MESSAGE, { unread: 3 })
    server(UNREAD_MESSAGE, { nope: true })
    const listing = api.stored()
    server(RESULT_MESSAGE, { requestId: lastRequest()[1].requestId, notifications: [], unread: 2 })
    await listing
    stop()
    server(UNREAD_MESSAGE, { unread: 0 })

    expect(counts).toEqual([3, 2])
    expect(api.unread).toBe(0)
    expect(game.trigger).toHaveBeenCalledWith(UNREAD_EVENT, 3)
  })

  it('rejects when the server says why, isn\'t there, answers too late or the connection changed', async () => {
    const offline = fakeGame()
    await expect(notifications(offline.ctx.game).stored()).rejects.toThrow('Not connected')

    const { api, server, lastRequest, ctx, game } = connected()
    const listing = api.stored()
    server(RESULT_MESSAGE, { requestId: lastRequest()[1].requestId, unread: 0, error: 'Notifications aren\'t kept: the server has no database' })
    await expect(listing).rejects.toThrow('no database')

    vi.useFakeTimers()
    try {
      const late = api.stored()
      vi.advanceTimersByTime(REQUEST_TIMEOUT_MS)
      await expect(late).rejects.toThrow('didn\'t answer in time')
    }
    finally {
      vi.useRealTimers()
    }

    const pending = api.markRead()
    game.network = {
      socket: {
        on: vi.fn(),
        emit: vi.fn(),
      },
    } as never
    plugin.update!(0.016, ctx)
    await expect(pending).rejects.toThrow('connection to the game server changed')

    // An answer nobody waits for is dropped
    expect(() => server(RESULT_MESSAGE, { requestId: 'unknown', unread: 0 })).not.toThrow()
  })
})
