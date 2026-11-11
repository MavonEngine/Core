import { describe, expect, it, vi } from 'vitest'
import NetRecorder from '../../../src/Networking/Debug/NetRecorder'
import { rememberJson, tapMessages } from '../../../src/Networking/Debug/tap'

describe('tapMessages', () => {
  it('records what passes through and still calls the original with the same arguments', () => {
    const recorder = new NetRecorder({ enabled: true })
    const original = vi.fn(() => 'sent')
    const channel = { _emit: original }

    tapMessages(channel, '_emit', 'out', recorder, 'p1')
    expect(channel._emit('sv_chat', { message: 'hi' })).toBe('sent')
    channel._emit('pong')

    expect(original.mock.calls).toEqual([['sv_chat', { message: 'hi' }], ['pong']])
    expect(original.mock.contexts[0]).toBe(channel)
    expect(recorder.list().records).toMatchObject([
      { direction: 'out', type: 'sv_chat', peer: 'p1', bytes: 16 },
      { direction: 'out', type: 'pong', peer: 'p1', bytes: 0 },
    ])
  })

  it('records a reliable message once, unwrapped', () => {
    const recorder = new NetRecorder({ enabled: true })
    const original = vi.fn()
    const emitter = { emit: original }
    tapMessages(emitter, 'emit', 'in', recorder)

    const wrapped = { MESSAGE: { name: 'Ada' }, RELIABLE: 1, ID: 'abc' }
    emitter.emit('cl_init', wrapped)
    emitter.emit('cl_init', wrapped)
    emitter.emit('cl_init', { MESSAGE: { name: 'Ada' }, RELIABLE: 1, ID: 'def' })

    expect(original).toHaveBeenCalledTimes(3)
    expect(recorder.list().records).toMatchObject([
      { type: 'cl_init', reliable: true, bytes: 14 },
      { type: 'cl_init', reliable: true },
    ])
    expect(recorder.get(1)).toMatchObject({ payload: { name: 'Ada' } })
  })

  it('leaves the transport\'s own events out', () => {
    const recorder = new NetRecorder({ enabled: true })
    const original = vi.fn()
    const emitter = { emit: original }
    tapMessages(emitter, 'emit', 'in', recorder)

    emitter.emit('disconnect', 'closed')
    emitter.emit('dropped', { reason: 'x' })

    expect(original).toHaveBeenCalledTimes(2)
    expect(recorder.list().records).toEqual([])
  })

  it('passes messages through unrecorded while the recorder is off', () => {
    const recorder = new NetRecorder()
    const original = vi.fn()
    const emitter = { emit: original }
    tapMessages(emitter, 'emit', 'in', recorder)

    emitter.emit('command', { type: 'cl_move' })

    expect(original).toHaveBeenCalledWith('command', { type: 'cl_move' })
    expect(recorder.latestId).toBe(0)
  })

  it('uses remembered JSON', () => {
    const recorder = new NetRecorder({ enabled: true })
    const channel = { _emit: vi.fn() }
    tapMessages(channel, '_emit', 'out', recorder)

    const state = { tick: 2 }
    rememberJson(state, '{"tick":1}')
    channel._emit('sv_state', state)

    expect(recorder.get(1)).toMatchObject({ payload: { tick: 1 } })
  })

  it('does nothing to a target without the method', () => {
    const recorder = new NetRecorder({ enabled: true })
    const mock = { emit: vi.fn() }

    tapMessages(mock, '_emit', 'out', recorder)
    tapMessages(undefined, 'emit', 'in', recorder)

    expect(Object.keys(mock)).toEqual(['emit'])
  })
})
