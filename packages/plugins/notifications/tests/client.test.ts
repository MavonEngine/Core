import type { ClientPluginContext } from '@mavonengine/core/Plugins/types'
import type { GameNotification } from '../src/client'
import { describe, expect, it, vi } from 'vitest'
import plugin, { NOTIFICATION_EVENT, NOTIFICATION_MESSAGE, notifications } from '../src/client'

function fakeGame() {
  const handlers = new Map<string, (data: unknown) => void>()
  const socket = { on: vi.fn((event: string, callback: (data: unknown) => void) => void handlers.set(event, callback)) }
  const game = { trigger: vi.fn(), network: undefined as { socket: typeof socket } | undefined }
  const logger = { error: vi.fn() }
  const ctx = { game, logger } as unknown as ClientPluginContext
  return {
    game,
    ctx,
    logger,
    connect: () => (game.network = { socket }),
    receive: (data: unknown) => handlers.get(NOTIFICATION_MESSAGE)!(data),
    socket,
  }
}

const levelUp: GameNotification = { id: 'n1', type: 'LevelUp', data: { level: 5 }, sentAt: '2026-11-19T12:00:00.000Z' }

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
    expect(socket.on).toHaveBeenCalledTimes(1)

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
