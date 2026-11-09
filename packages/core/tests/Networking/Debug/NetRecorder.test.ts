import { describe, expect, it } from 'vitest'
import NetRecorder, { byteLength, describePayload, parseNetRecordQuery } from '../../../src/Networking/Debug/NetRecorder'

describe('netRecorder', () => {
  it('records nothing while it is off', () => {
    const recorder = new NetRecorder()

    expect(recorder.packet('out', 'sv_state', { tick: 1 })).toBeUndefined()
    expect(recorder.event('connect')).toBeUndefined()
    expect(recorder.list()).toEqual({ enabled: false, latestId: 0, matched: 0, records: [] })
  })

  it('records packets with their size and the facts of the payload', () => {
    const recorder = new NetRecorder({ enabled: true })

    const state = { type: 'sv_state', tick: 7, ack: 3, sequenceId: 0, entities: [{}, {}] }
    const command = { type: 'cl_move', sequenceId: 4 }
    recorder.packet('out', 'sv_state', state, { peer: 'p1', timestamp: 1000 })
    recorder.packet('in', 'command', command, { peer: 'p1', timestamp: 1001 })
    recorder.packet('in', 'ping', null, { peer: 'p1', timestamp: 1002 })

    const { records } = recorder.list()
    expect(records).toEqual([
      { id: 1, timestamp: 1000, kind: 'packet', direction: 'out', type: 'sv_state', peer: 'p1', bytes: JSON.stringify(state).length, tick: 7, sequenceId: undefined, info: { entities: 2, ack: 3 }, hasPayload: true },
      { id: 2, timestamp: 1001, kind: 'packet', direction: 'in', type: 'command', peer: 'p1', bytes: JSON.stringify(command).length, tick: undefined, sequenceId: 4, info: { command: 'cl_move' }, hasPayload: true },
      { id: 3, timestamp: 1002, kind: 'packet', direction: 'in', type: 'ping', peer: 'p1', bytes: 0, hasPayload: false },
    ])
  })

  it('uses the JSON it is given instead of serializing again', () => {
    const recorder = new NetRecorder({ enabled: true })
    const data = {
      toJSON: () => {
        throw new Error('serialized twice')
      },
    }

    recorder.packet('out', 'sv_state', data, { json: '{"tick":1}' })

    expect(recorder.get(1)).toMatchObject({ bytes: 10, payload: { tick: 1 } })
  })

  it('filters by id, kind, direction, type and peer, keeping the newest', () => {
    const recorder = new NetRecorder({ enabled: true })
    recorder.event('connect', { peer: 'a' })
    recorder.packet('out', 'sv_state', {}, { peer: 'a' })
    recorder.packet('out', 'sv_state', {}, { peer: 'b' })
    recorder.packet('in', 'command', {}, { peer: 'a' })
    recorder.packet('in', 'ping', null, { peer: 'a' })

    const ids = (query: Parameters<NetRecorder['list']>[0]) => recorder.list(query).records.map(record => record.id)

    expect(ids({ after: 3 })).toEqual([4, 5])
    expect(ids({ kind: 'event' })).toEqual([1])
    expect(ids({ direction: 'out' })).toEqual([2, 3])
    expect(ids({ type: 'command, ping' })).toEqual([4, 5])
    expect(ids({ peer: 'b' })).toEqual([3])
    expect(recorder.list({ limit: 2 })).toMatchObject({ latestId: 5, matched: 5, records: [{ id: 4 }, { id: 5 }] })
  })

  it('keeps only the newest records', () => {
    const recorder = new NetRecorder({ enabled: true, size: 3 })
    for (let i = 0; i < 5; i++)
      recorder.packet('out', 'sv_state', { tick: i })

    expect(recorder.list().records.map(record => record.id)).toEqual([3, 4, 5])
    expect(recorder.get(2)).toBeUndefined()
    expect(recorder.get(4)).toMatchObject({ id: 4, payload: { tick: 3 } })
    expect(recorder.get(6)).toBeUndefined()
  })

  it('drops the oldest payloads over the budget but keeps their records', () => {
    const recorder = new NetRecorder({ enabled: true, payloadBudget: 25 })
    recorder.packet('out', 'a', { value: 'aaaaa' }) // 17 chars
    recorder.packet('out', 'b', { value: 'bbbbb' })
    recorder.packet('out', 'c', { value: 'ccccc' })

    expect(recorder.list().records.map(record => record.hasPayload)).toEqual([false, false, true])
    expect(recorder.get(1)).toMatchObject({ type: 'a', bytes: 17, hasPayload: false })
    expect(recorder.get(1)).not.toHaveProperty('payload')
    expect(recorder.get(3)).toMatchObject({ payload: { value: 'ccccc' } })
  })

  it('runs onEnabled hooks once recording starts', () => {
    const recorder = new NetRecorder()
    let hooked = 0
    recorder.onEnabled(() => hooked++)
    expect(hooked).toBe(0)

    recorder.enabled = true
    recorder.enabled = false
    recorder.enabled = true
    expect(hooked).toBe(1)

    recorder.onEnabled(() => hooked++)
    expect(hooked).toBe(2)
  })

  it('clears', () => {
    const recorder = new NetRecorder({ enabled: true })
    recorder.packet('out', 'a', { a: 1 })
    recorder.clear()

    expect(recorder.list()).toMatchObject({ latestId: 1, records: [] })
    recorder.packet('out', 'b', { b: 1 })
    expect(recorder.get(2)).toMatchObject({ type: 'b' })
  })
})

describe('describePayload', () => {
  it('ignores payloads that are not objects', () => {
    expect(describePayload('ping', null)).toEqual({})
    expect(describePayload('raw', 'text')).toEqual({})
  })

  it('reads the id of a removed entity', () => {
    expect(describePayload('sv_remove_entity', { id: 'rock' })).toEqual({ tick: undefined, sequenceId: undefined, info: { id: 'rock' } })
  })
})

describe('byteLength', () => {
  it('counts UTF-8 bytes', () => {
    expect(byteLength('abc')).toBe(3)
    expect(byteLength('ä€')).toBe(5)
  })
})

describe('parseNetRecordQuery', () => {
  it('parses query string params', () => {
    expect(parseNetRecordQuery({ after: '12', limit: '5', kind: 'packet', direction: 'in', type: 'sv_state', peer: 'p1' }))
      .toEqual({ after: 12, limit: 5, kind: 'packet', direction: 'in', type: 'sv_state', peer: 'p1' })
    expect(parseNetRecordQuery({ after: '', kind: '' })).toEqual({})
  })

  it('rejects bad values', () => {
    expect(parseNetRecordQuery({ after: 'x' })).toBe('after must be a non-negative integer')
    expect(parseNetRecordQuery({ limit: '-1' })).toBe('limit must be a non-negative integer')
    expect(parseNetRecordQuery({ kind: 'frame' })).toBe('kind must be packet or event')
    expect(parseNetRecordQuery({ direction: 'up' })).toBe('direction must be in or out')
  })
})
