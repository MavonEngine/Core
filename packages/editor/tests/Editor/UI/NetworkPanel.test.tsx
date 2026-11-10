// @vitest-environment jsdom

import NetRecorder from '@mavonengine/core/Networking/Debug/NetRecorder'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import SyncStore from '../../../src/Editor/Network/SyncStore'
import { describeRecord, filterRecords, formatBytes, formatTime } from '../../../src/Editor/UI/Network/format'
import NetworkPanel from '../../../src/Editor/UI/Network/NetworkPanel'

vi.mock('../../../src/Editor/UI/Network/NetworkPanel.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))

const sync = {
  tick: 40,
  serverTime: 0,
  tickRate: 30,
  syncDistance: 100,
  players: [{ id: 'p1', displayName: 'Ada', position: { x: 0, y: 0, z: 0 }, ack: 7, tracked: ['p1', 'rock'], lastState: { tick: 40, bytes: 2048, entities: 2 } }],
  editors: ['e1'],
  entities: [
    { id: 'rock', type: 'rock', player: false, trackedBy: 1 },
    { id: 'tree', type: 'tree', player: false, trackedBy: 0 },
  ],
}

let net: NetRecorder
let overlay: { options: { ghosts: boolean, rings: boolean, viewAs: string | null }, setOptions: ReturnType<typeof vi.fn>, on: ReturnType<typeof vi.fn>, off: ReturnType<typeof vi.fn>, sync: SyncStore }
let fetchMock: ReturnType<typeof vi.fn>

/** Let the polls that are under way finish and render */
function settle() {
  return act(async () => {
    await vi.advanceTimersByTimeAsync(600)
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  net = new NetRecorder({ enabled: true })
  net.packet('out', 'command', { type: 'cl_move', sequenceId: 3 })
  net.packet('in', 'sv_state', { tick: 40, ack: 3, entities: [{ id: 'rock' }] })
  net.packet('out', 'ping', null)
  net.event('state_gap', { tick: 42, info: { missed: 1 } })

  overlay = {
    options: { ghosts: false, rings: false, viewAs: null },
    setOptions: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    sync: new SyncStore(250, async () => sync as any),
  }

  fetchMock = vi.fn(async () => new Response('', { status: 404 }))
  vi.stubGlobal('fetch', fetchMock)
  ;(window as any).Game = {
    editor: { networkOverlay: overlay },
    network: { connected: true, ping: 23, net, serverView: { tick: 40, receivedAt: performance.now(), missedStates: 1 } },
  }
})

afterEach(() => {
  cleanup()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('networkPanel', () => {
  it('explains when the server\'s records cannot be read', async () => {
    render(<NetworkPanel />)
    await settle()

    screen.getByText(/has no network debug endpoints here/)
    expect(String(fetchMock.mock.calls[0][0])).toBe('/api/game/dev/net/packets?after=0&limit=1000')
  })

  it('lists the server\'s records, newest first', async () => {
    fetchMock.mockImplementation(async () => Response.json({
      enabled: true,
      latestId: 2,
      matched: 2,
      records: [
        { id: 1, timestamp: 0, kind: 'packet', direction: 'out', type: 'sv_state', peer: 'p1', bytes: 2048, tick: 40, info: { entities: 2, ack: 7 }, hasPayload: true },
        { id: 2, timestamp: 1, kind: 'event', type: 'sync_leave', peer: 'p1', info: { count: 1, entities: ['rock'] }, hasPayload: false },
      ],
    }))
    render(<NetworkPanel />)
    await settle()

    const rows = screen.getAllByRole('row').map(row => row.textContent)
    expect(rows[0]).toContain('sync_leave')
    expect(rows[0]).toContain('count 1 · entities rock')
    expect(rows[1]).toContain('sv_state')
    expect(rows[1]).toContain('2.00 kB')
    expect(rows[1]).toContain('tick 40 · entities 2 · ack 7')
  })

  it('shows this tab\'s own records, without pings unless asked, and a payload on click', async () => {
    render(<NetworkPanel />)
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'client' } })
    await settle()

    expect(screen.queryByText('ping')).toBeNull()
    screen.getByText('state_gap')
    screen.getByText('seq 3 · command cl_move')

    fireEvent.click(screen.getByLabelText('Pings'))
    screen.getByText('ping')

    fireEvent.change(screen.getByPlaceholderText('Filter by message or client'), { target: { value: 'sv_' } })
    expect(screen.queryByText('state_gap')).toBeNull()
    expect(screen.queryByText('ping')).toBeNull()

    fireEvent.click(screen.getByText('sv_state'))
    await settle()
    expect(screen.getByText(/"ack": 3/).textContent).toContain('"id": "rock"')
  })

  it('stops reading while paused', async () => {
    render(<NetworkPanel />)
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'client' } })
    await settle()

    fireEvent.click(screen.getByText('Pause'))
    net.packet('in', 'sv_chat', { message: 'hi' })
    await settle()
    expect(screen.queryByText('sv_chat')).toBeNull()

    fireEvent.click(screen.getByText('Resume'))
    await settle()
    screen.getByText('sv_chat')

    fireEvent.click(screen.getByText('Clear'))
    expect(screen.queryByText('sv_chat')).toBeNull()
  })

  it('shows the connection and the state sync, and switches the overlay', async () => {
    render(<NetworkPanel />)
    await settle()

    screen.getByText(/23 ms · tick 40 · state \d+ ms ago · 1 missed/)
    screen.getByText(/Tick 40 · 30 Hz · sync distance 100 · 2 synced entities, 1 out of every player's range · 1 editor/)
    const player = screen.getByText('Ada').closest('tr')!
    expect(player.textContent).toBe('Ada272.00 kB · tick 40')

    fireEvent.click(player)
    expect(overlay.setOptions).toHaveBeenCalledWith({ viewAs: 'p1' })
    fireEvent.click(screen.getByLabelText('Server ghosts'))
    expect(overlay.setOptions).toHaveBeenCalledWith({ ghosts: true })
    fireEvent.click(screen.getByLabelText('Sync radius'))
    expect(overlay.setOptions).toHaveBeenCalledWith({ rings: true })
  })

  it('says when the tab has no game connection', async () => {
    delete (window as any).Game.network
    render(<NetworkPanel />)
    fireEvent.change(screen.getByLabelText('Source'), { target: { value: 'client' } })
    await settle()

    screen.getByText('This tab has no game connection')
    screen.getByText('This tab is not connected to a game server')
  })
})

describe('format', () => {
  it('formats sizes and times', () => {
    expect(formatBytes(undefined)).toBe('')
    expect(formatBytes(512)).toBe('512 B')
    expect(formatBytes(1536)).toBe('1.50 kB')
    expect(formatBytes(20480)).toBe('20.0 kB')
    expect(formatTime(new Date(2026, 0, 1, 9, 5, 7, 42).getTime())).toBe('09:05:07.042')
  })

  it('describes a record in one line', () => {
    expect(describeRecord({ id: 1, timestamp: 0, kind: 'packet', type: 'cl_init', reliable: true, hasPayload: true })).toBe('reliable')
    expect(describeRecord({ id: 1, timestamp: 0, kind: 'event', type: 'connect', hasPayload: false })).toBe('')
  })

  it('filters records', () => {
    const records = [
      { id: 1, timestamp: 0, kind: 'packet' as const, type: 'ping', peer: 'abc', hasPayload: false },
      { id: 2, timestamp: 0, kind: 'packet' as const, type: 'sv_state', peer: 'abc', hasPayload: true },
      { id: 3, timestamp: 0, kind: 'event' as const, type: 'connect', peer: 'xyz', hasPayload: false },
    ]
    const ids = (filter: Parameters<typeof filterRecords>[1]) => filterRecords(records, filter).map(record => record.id)

    expect(ids({ kind: 'all', pings: false, text: '' })).toEqual([2, 3])
    expect(ids({ kind: 'all', pings: true, text: '' })).toEqual([1, 2, 3])
    expect(ids({ kind: 'event', pings: true, text: '' })).toEqual([3])
    expect(ids({ kind: 'all', pings: true, text: 'ABC' })).toEqual([1, 2])
  })
})
