import type { DashboardState } from '../src/dashboard/MetricsClient'
import type { StartupInfo, ViewState } from '../src/dashboard/view'
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
    requests: [
      { id: 1, timestamp: 0, method: 'GET', path: '/assets/index.js', status: 200, durationMs: 3.2, bytes: 412000, address: '203.0.113.10' },
      { id: 2, timestamp: 0, method: 'GET', path: '/favicon.ico', status: 404, durationMs: 0.8, bytes: 160, address: '203.0.113.10' },
      { id: 3, timestamp: 0, method: 'WS', path: '/hmr', status: 101, durationMs: 1.1, bytes: 129, address: '127.0.0.1' },
    ],
    requestsAvailable: true,
  }
}

function viewState(overrides: Partial<ViewState> = {}): ViewState {
  return { tab: 0, playerOffset: 0, logFromEnd: 0, requestTopId: null, selectedPlayerId: null, followSelectedPlayer: true, ...overrides }
}

function render(state: DashboardState, width = 130, height = 40, transparent = false, tab = 0, view = viewState({ tab }), startup?: StartupInfo) {
  return renderToScreen(({ ui, theme }) => renderDashboard(ui, theme, state, view, { transparent, startup }), { width, height })
}

function startingState(status: DashboardState['status']): DashboardState {
  return { status, source: 'http://localhost:8050/api/game/metrics', snapshot: null, lastUpdate: null, error: 'Can\'t reach', failures: 3, logs: [], logsAvailable: null, requests: [], requestsAvailable: null }
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

  it('shows HTTP requests, newest first, on the http tab', async () => {
    const screen = render(await liveState(), 130, 40, false, 3)

    expect(screen.contains('4 HTTP')).toBe(true)
    expect(screen.contains('HTTP requests (3, 1 error)')).toBe(true)
    for (const text of ['/assets/index.js', '/favicon.ico', '404', 'WS', '/hmr', '402.3 KiB'])
      expect(screen.contains(text), text).toBe(true)
    expect(screen.find('/hmr')!.y).toBeLessThan(screen.find('/favicon.ico')!.y)
    expect(screen.contains('Slow tick')).toBe(false)
  })

  it('keeps a scrolled http table on the same request as new ones arrive', async () => {
    const state = await liveState()
    const request = (id: number) => ({ id, timestamp: 0, method: 'GET', path: `/page-${id}`, status: 200, durationMs: 1, bytes: 10, address: null })
    state.requests = Array.from({ length: 80 }, (_, i) => request(i + 1))
    const view = viewState({ tab: 3, requestTopId: 60 })

    state.requests.push(request(81))
    const screen = render(state, 130, 40, false, 3, view)

    expect(screen.find('/page-60 ')!.y).toBe(screen.find('Time')!.y + 1)
    expect(screen.contains('/page-81')).toBe(false)
    expect(screen.contains('scroll up to follow')).toBe(true)
    expect(view.requestTopId).toBe(60)
  })

  it('follows the newest requests again once everything fits', async () => {
    const view = viewState({ tab: 3, requestTopId: 2 })

    const screen = render(await liveState(), 130, 40, false, 3, view)

    expect(screen.contains('/hmr')).toBe(true)
    expect(view.requestTopId).toBeNull()
  })

  it('explains when the server does not record requests', async () => {
    const state = await liveState()
    state.requests = []
    state.requestsAvailable = false

    expect(render(state, 130, 40, false, 3).contains('requestLogSize')).toBe(true)
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
    expect(tabForKey('4')).toBe(3)
    expect(tabForKey('5')).toBeNull()
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
      requests: [],
      requestsAvailable: null,
    })

    expect(screen.contains('UNAUTHORIZED')).toBe(true)
    expect(screen.contains('use --token')).toBe(true)
    expect(screen.contains('attempt 2')).toBe(true)
  })

  it('shows the open key once the server answers, when there is a client to open', async () => {
    const state = await liveState()
    const withKey = renderToScreen(({ ui, theme }) => renderDashboard(ui, theme, state, viewState(), { openKey: true }), { width: 130, height: 40 })
    const starting = renderToScreen(({ ui, theme }) => renderDashboard(ui, theme, startingState('connecting'), viewState(), { openKey: true }), { width: 130, height: 40 })

    expect(withKey.contains('Open game')).toBe(true)
    expect(render(state).contains('Open game')).toBe(false)
    expect(starting.contains('Open game')).toBe(false)
  })

  it('shows the startup screen while the dev server starts', () => {
    const screen = render(startingState('unreachable'), 130, 40, false, 0, viewState(), {
      engineVersion: '0.0.20',
      output: '\u001B[32mbuilding\u001B[39m\n\nESM Build success\n',
    })

    expect(screen.contains('MavonEngine')).toBe(true)
    expect(screen.contains('Version:  0.0.20')).toBe(true)
    expect(screen.contains('Starting the game server')).toBe(true)
    expect(screen.contains('ESM Build success')).toBe(true)
    expect(screen.contains('STARTING')).toBe(true)
    expect(screen.contains('UNREACHABLE')).toBe(false)
  })

  it('shows what mavonengine create is doing on the startup screen', () => {
    const screen = render(startingState('connecting'), 130, 40, false, 0, viewState(), {
      output: 'Running \'npm install\'\nadded 312 packages\n',
      label: 'Installing dependencies…',
      outputTitle: 'Setup',
    })

    expect(screen.contains('Installing dependencies')).toBe(true)
    expect(screen.contains('Setup')).toBe(true)
    expect(screen.contains('added 312 packages')).toBe(true)
    expect(screen.contains('Starting the game server')).toBe(false)
  })

  it('draws the logo above the banner when the terminal is tall enough', () => {
    const startup = { engineVersion: '0.0.20', output: '' }
    const logo = (height: number, capabilities = {}) => renderToScreen(
      ({ ui, theme }) => renderDashboard(ui, theme, startingState('unreachable'), viewState(), { startup }),
      { width: 130, height, capabilities },
    ).contains('▀')

    expect(logo(60)).toBe(true)
    // Room for the smaller size only
    expect(logo(46)).toBe(true)
    expect(logo(30)).toBe(false)
    expect(logo(60, { unicode: false })).toBe(false)
    expect(logo(60, { colors: 'ansi16' })).toBe(false)
  })

  it('leaves the startup screen for a server that answers with an error', () => {
    const state = startingState('unauthorized')
    state.error = 'Metrics token missing or wrong (use --token)'
    const screen = render(state, 130, 40, false, 0, viewState(), { output: '' })

    expect(screen.contains('Starting the game server')).toBe(false)
    expect(screen.contains('use --token')).toBe(true)
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
