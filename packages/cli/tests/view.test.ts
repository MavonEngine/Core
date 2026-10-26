import type { DashboardState } from '../src/dashboard/MetricsClient'
import type { ViewState } from '../src/dashboard/view'
import { DEFAULT_COLOR, renderToScreen } from '@profullstack/hqtui'
import { describe, expect, it } from 'vitest'
import { simulatedSource } from '../src/dashboard/simulator'
import { normalizeSnapshot } from '../src/dashboard/snapshot'
import { handlePlayersKey, renderDashboard, tabForKey, toLogRows } from '../src/dashboard/view'

async function liveState(samples = 30): Promise<DashboardState> {
  const source = simulatedSource()
  let raw: unknown
  for (let i = 0; i < samples; i++)
    raw = await source.fetch()

  return {
    status: 'live',
    source: 'http://localhost:8050/api/game/metrics',
    snapshot: normalizeSnapshot(raw),
    lastUpdate: Date.now(),
    error: null,
    failures: 0,
    logs: [
      { id: 1, timestamp: 0, level: 'info', message: 'Starting @mavon/engine - Socket Server' },
      { id: 2, timestamp: 0, level: 'warn', message: 'Slow tick: 40.1 ms (budget 33.33 ms)' },
    ],
    logsAvailable: true,
  }
}

function viewState(overrides: Partial<ViewState> = {}): ViewState {
  return { tab: 0, playerOffset: 0, logFromEnd: 0, selectedPlayerId: null, followSelectedPlayer: true, ...overrides }
}

function render(state: DashboardState, width = 130, height = 40, transparent = false, tab = 0, view = viewState({ tab })) {
  return renderToScreen(({ ui, theme }) => renderDashboard(ui, theme, state, view, { transparent }), { width, height })
}

describe('dashboard view', () => {
  it('shows every panel when live', async () => {
    const screen = render(await liveState())

    for (const title of ['CPU', 'Network', 'Tick', 'World', 'Players (', 'LIVE', 'q Quit'])
      expect(screen.contains(title), title).toBe(true)

    expect(screen.contains('sim-01')).toBe(true)
  })

  it('shows only the players on the players tab', async () => {
    const screen = render(await liveState(), 130, 40, false, 1)

    expect(screen.contains('2 Players')).toBe(true)
    expect(screen.contains('Players (')).toBe(true)
    expect(screen.contains('sim-01')).toBe(true)
    expect(screen.contains('CPU')).toBe(false)
    expect(screen.contains('Slow tick')).toBe(false)
  })

  it('shows only the logs on the logs tab', async () => {
    const screen = render(await liveState(), 130, 40, false, 2)

    expect(screen.contains('Slow tick')).toBe(true)
    expect(screen.contains('Players (')).toBe(false)
    expect(screen.contains('CPU')).toBe(false)
  })

  it('shows a details tile for the selected player', async () => {
    const state = await liveState()
    const player = state.snapshot!.players[0]

    const closed = render(state, 130, 40, false, 1)
    expect(closed.contains(player.connection!.address!)).toBe(false)

    for (const [width, height] of [[130, 40], [80, 60]]) {
      const screen = render(state, width, height, false, 1, viewState({ tab: 1, selectedPlayerId: player.id }))
      expect(screen.contains(player.connection!.address!), `${width}x${height}`).toBe(true)
      expect(screen.contains('Connected')).toBe(true)
      expect(screen.contains('esc Close')).toBe(true)
    }
  })

  it('explains a player without a connection', async () => {
    const state = await liveState()
    const player = state.snapshot!.players[0]
    player.connection = null

    const screen = render(state, 130, 40, false, 1, viewState({ tab: 1, selectedPlayerId: player.id }))
    expect(screen.contains('No live connection')).toBe(true)
  })

  it('drops the selection when the player disconnects', async () => {
    const state = await liveState()
    const view = viewState({ tab: 1, selectedPlayerId: 'gone' })

    render(state, 130, 40, false, 1, view)
    expect(view.selectedPlayerId).toBeNull()
  })

  it('moves the player selection with the arrow keys', async () => {
    const { snapshot } = await liveState()
    const ids = snapshot!.players.map(p => p.id).sort()
    const view = viewState({ tab: 1 })

    expect(handlePlayersKey(view, snapshot, 'down')).toBe(true)
    expect(view.selectedPlayerId).toBe(ids[0])
    handlePlayersKey(view, snapshot, 'j')
    expect(view.selectedPlayerId).toBe(ids[1])
    handlePlayersKey(view, snapshot, 'up')
    handlePlayersKey(view, snapshot, 'up')
    expect(view.selectedPlayerId).toBe(ids[0])

    expect(handlePlayersKey(view, snapshot, 'escape')).toBe(true)
    expect(view.selectedPlayerId).toBeNull()
    expect(handlePlayersKey(view, snapshot, 'escape')).toBe(false)
  })

  it('ignores the arrow keys outside the players tab', async () => {
    const { snapshot } = await liveState()
    const view = viewState({ tab: 0 })

    expect(handlePlayersKey(view, snapshot, 'down')).toBe(false)
    expect(view.selectedPlayerId).toBeNull()
  })

  it('maps number keys to tabs', () => {
    expect(tabForKey('1')).toBe(0)
    expect(tabForKey('3')).toBe(2)
    expect(tabForKey('4')).toBeNull()
    expect(tabForKey('0')).toBeNull()
    expect(tabForKey('q')).toBeNull()
  })

  it('fits a narrow terminal', async () => {
    const screen = render(await liveState(), 80, 60)

    expect(screen.contains('CPU')).toBe(true)
    expect(screen.contains('Players (')).toBe(true)
  })

  it('shows a waiting panel before the first snapshot', () => {
    const screen = render({
      status: 'unauthorized',
      source: 'http://x.test',
      snapshot: null,
      lastUpdate: null,
      error: 'Metrics token missing or wrong (use --token)',
      failures: 2,
      logs: [],
      logsAvailable: null,
    })

    expect(screen.contains('UNAUTHORIZED')).toBe(true)
    expect(screen.contains('use --token')).toBe(true)
    expect(screen.contains('attempt 2')).toBe(true)
  })

  it('keeps the last values and shows the error when the server drops', async () => {
    const state = await liveState()
    state.status = 'unreachable'
    state.error = 'Can\'t reach localhost'

    const screen = render(state)

    expect(screen.contains('showing last known values')).toBe(true)
    expect(screen.contains('UNREACHABLE')).toBe(true)
    expect(screen.contains('CPU')).toBe(true)
  })

  it('warns when latency simulation is on', async () => {
    const state = await liveState()
    state.snapshot!.latencySimulation = { fixedLatency: 100, jitter: 20, packetLoss: 0.05 }

    expect(render(state).contains('LATENCY SIMULATION ON')).toBe(true)
  })

  it('shows an empty players message', async () => {
    const state = await liveState()
    state.snapshot!.players = []

    expect(render(state).contains('No players connected')).toBe(true)
  })

  it('shows the name column only when a player has a name besides its id', async () => {
    const state = await liveState()
    expect(render(state).contains('Name')).toBe(true)

    for (const player of state.snapshot!.players)
      player.displayName = player.id
    expect(render(state).contains('Name')).toBe(false)
  })

  it('fills the status bar unless transparent', async () => {
    const state = await liveState()

    const opaque = render(state)
    const quit = opaque.find('Quit')!
    expect(opaque.cell(quit.x, quit.y).bg).not.toBe(DEFAULT_COLOR)

    const transparent = render(state, 130, 40, true)
    const quitTransparent = transparent.find('Quit')!
    expect(transparent.cell(quitTransparent.x, quitTransparent.y).bg).toBe(DEFAULT_COLOR)
  })

  it('shows log lines', async () => {
    const screen = render(await liveState())

    expect(screen.contains('Logs')).toBe(true)
    expect(screen.contains('Starting @mavon/engine - Socket Server')).toBe(true)
    expect(screen.contains('WARN')).toBe(true)
  })

  it('shows logs in the narrow layout', async () => {
    expect(render(await liveState(), 80, 70).contains('Slow tick')).toBe(true)
  })

  it('explains when the server does not serve logs', async () => {
    const state = await liveState()
    state.logs = []
    state.logsAvailable = false

    expect(render(state).contains('Not available')).toBe(true)
  })
})

describe('toLogRows', () => {
  it('splits multi-line messages and trims blank edges', () => {
    const rows = toLogRows([{ id: 1, timestamp: 0, level: 'info', message: '\n\n┌──┐\n│ME│\n└──┘\n' }])

    expect(rows).toHaveLength(3)
    expect(rows[0]).toMatchObject({ level: 'info', message: '┌──┐' })
    expect(rows[1]).not.toHaveProperty('level')
    expect(rows[2].message.trim()).toBe('└──┘')
  })
})
