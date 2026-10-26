import type { DashboardState } from '../src/dashboard/MetricsClient'
import { renderToScreen } from '@profullstack/hqtui'
import { describe, expect, it } from 'vitest'
import { simulatedSource } from '../src/dashboard/simulator'
import { normalizeSnapshot } from '../src/dashboard/snapshot'
import { renderDashboard } from '../src/dashboard/view'

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
  }
}

function render(state: DashboardState, width = 130, height = 40) {
  return renderToScreen(({ ui, theme }) => renderDashboard(ui, theme, state, { playerOffset: 0 }), { width, height })
}

describe('dashboard view', () => {
  it('shows every panel when live', async () => {
    const screen = render(await liveState())

    for (const title of ['CPU', 'Network', 'Tick', 'World', 'Players (', 'LIVE', 'q Quit'])
      expect(screen.contains(title), title).toBe(true)

    expect(screen.contains('sim-01')).toBe(true)
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
})
