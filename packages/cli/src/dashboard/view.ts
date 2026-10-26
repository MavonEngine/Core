import type { Color, Container, Span, Theme } from '@profullstack/hqtui'
import type { ConnectionStatus, DashboardState } from './MetricsClient'
import type { LogLine, ServerMetricsSnapshot } from './snapshot'
import { stripVTControlCharacters } from 'node:util'
import { bootBanner } from '@mavonengine/core/Utils/BootBanner'
import { DEFAULT_COLOR } from '@profullstack/hqtui'
import { formatBytes, formatDuration, formatMs, formatPercent, formatRate } from './format'
import { SUPPORTED_SCHEMA_VERSION } from './snapshot'

/**
 * UI state that lives across frames but isn't part of the metrics.
 */
export interface ViewState {
  /** Index into DASHBOARD_TABS */
  tab: number
  playerOffset: number
  /** Player shown in the details tile on the Players tab */
  selectedPlayerId: string | null
  /** Keep the selected row on screen; off while the mouse wheel scrolls the table */
  followSelectedPlayer: boolean
  /** Log lines scrolled back from the newest, 0 follows the tail */
  logFromEnd: number
}

export interface RenderOptions {
  /**
   * Leave cells on the terminal's default background so a transparent terminal shows through.
   * Text is only as readable as whatever is behind the window.
   */
  transparent?: boolean
  /** Set while `mavonengine dev` waits for the game server it started */
  startup?: StartupInfo
}

export interface StartupInfo {
  /** The project's @mavonengine/core version, if it is installed */
  engineVersion?: string
  /** What the dev script printed so far */
  output: string
}

type PlayerRow = ServerMetricsSnapshot['players'][number]

export const DASHBOARD_TABS = ['Overview', 'Players', 'Logs'] as const

const WIDE_LAYOUT = 100
const NEWLINE_RE = /\r?\n/

const STATUS_LABELS: Record<ConnectionStatus, string> = {
  connecting: 'CONNECTING',
  live: 'LIVE',
  unreachable: 'UNREACHABLE',
  unauthorized: 'UNAUTHORIZED',
  forbidden: 'FORBIDDEN',
  disabled: 'METRICS DISABLED',
}

/**
 * The tab a number key switches to, or null if the key isn't one.
 */
export function tabForKey(key: string): number | null {
  const index = Number(key) - 1
  return Number.isInteger(index) && index >= 0 && index < DASHBOARD_TABS.length ? index : null
}

function sortedPlayers(players: ServerMetricsSnapshot['players']) {
  return [...players].sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Arrow keys / j k move the player selection on the Players tab, escape clears it.
 * Returns whether the key was used.
 */
export function handlePlayersKey(view: ViewState, snapshot: ServerMetricsSnapshot | null, key: string): boolean {
  if (DASHBOARD_TABS[view.tab] !== 'Players' || !snapshot)
    return false

  if (key === 'escape') {
    const had = view.selectedPlayerId !== null
    view.selectedPlayerId = null
    return had
  }

  const delta = key === 'down' || key === 'j' ? 1 : key === 'up' || key === 'k' ? -1 : 0
  const rows = sortedPlayers(snapshot.players)
  if (delta === 0 || rows.length === 0)
    return false

  const current = rows.findIndex(p => p.id === view.selectedPlayerId)
  const next = current === -1
    ? (delta > 0 ? 0 : rows.length - 1)
    : Math.max(0, Math.min(rows.length - 1, current + delta))

  view.selectedPlayerId = rows[next].id
  view.followSelectedPlayer = true
  return true
}

function statusColor(status: ConnectionStatus, theme: Theme): Color {
  if (status === 'live')
    return theme.success
  if (status === 'connecting')
    return theme.warning
  return theme.danger
}

/**
 * Draw the whole dashboard. Pure apart from `view`, so it can be rendered in tests.
 */
export function renderDashboard(ui: Container, theme: Theme, state: DashboardState, view: ViewState, { transparent = false, startup }: RenderOptions = {}) {
  const { snapshot } = state
  const starting = !snapshot && !!startup && (state.status === 'connecting' || state.status === 'unreachable')

  ui.column({}, (root) => {
    header(root, theme, state)

    if (snapshot?.latencySimulation)
      latencyBanner(root, theme, snapshot.latencySimulation)

    if (state.error && snapshot)
      root.text([{ text: ` ${state.error} — showing last known values`, fg: theme.danger }], { size: 1 })

    if (starting) {
      startupScreen(root, theme, startup!)
    }
    else if (!snapshot) {
      waiting(root, theme, state)
    }
    else {
      root.tabs({
        tabs: DASHBOARD_TABS.map((name, i) => `${i + 1} ${name}`),
        active: view.tab,
        size: 1,
        onSelect: (index) => {
          view.tab = index
          root.ctx.invalidate()
        },
      })

      const tab = DASHBOARD_TABS[view.tab] ?? 'Overview'
      if (tab === 'Players') {
        playersTab(root, theme, snapshot, view, transparent)
      }
      else if (tab === 'Logs') {
        logsPanel(root, theme, state, view)
      }
      else {
        root.responsive({
          [WIDE_LAYOUT]: c => wideLayout(c, theme, state, snapshot, view, transparent),
          0: c => narrowLayout(c, theme, state, snapshot, view, transparent),
        })
      }
    }

    root.statusBar({
      size: 1,
      background: transparent ? DEFAULT_COLOR : undefined,
      items: [
        { key: 'q', label: 'Quit' },
        { key: 'r', label: 'Refresh' },
        { key: `1-${DASHBOARD_TABS.length}`, label: 'Tabs' },
        ...(snapshot && DASHBOARD_TABS[view.tab] === 'Players'
          ? [{ key: '↑↓', label: 'Select player' }, ...(view.selectedPlayerId ? [{ key: 'esc', label: 'Close' }] : [])]
          : []),
      ],
      right: [starting
        ? { label: 'STARTING', color: statusColor('connecting', theme) }
        : { label: STATUS_LABELS[state.status], color: statusColor(state.status, theme), active: state.status === 'live' }],
    })
  })
}

function header(ui: Container, theme: Theme, state: DashboardState) {
  const spans: Span[] = [
    { text: ' MavonEngine ', fg: theme.primary, bold: true },
    { text: state.source, fg: theme.muted },
  ]

  if (state.snapshot) {
    spans.push(
      { text: '  uptime ', fg: theme.muted },
      { text: formatDuration(state.snapshot.uptime) },
      { text: '  engine ', fg: theme.muted },
      { text: state.snapshot.engineVersion },
    )

    if (state.snapshot.schemaVersion > SUPPORTED_SCHEMA_VERSION)
      spans.push({ text: '  newer metrics schema, update @mavonengine/cli', fg: theme.warning })
  }

  ui.text(spans, { size: 1 })
}

function latencyBanner(ui: Container, theme: Theme, latency: NonNullable<ServerMetricsSnapshot['latencySimulation']>) {
  ui.text([{
    text: ` LATENCY SIMULATION ON  ${latency.fixedLatency}ms ± ${latency.jitter / 2}ms, ${formatPercent(latency.packetLoss * 100)} packet loss `,
    fg: theme.background,
    bg: theme.warning,
    bold: true,
  }], { size: 1 })
}

/** Dev script output lines shown under the banner while the server starts */
const STARTUP_OUTPUT_LINES = 8

function startupScreen(ui: Container, theme: Theme, { engineVersion, output }: StartupInfo) {
  const label = 'Starting the game server…'
  const lines = stripVTControlCharacters(output).split(NEWLINE_RE).filter(line => line.trim() !== '')

  ui.column({ size: '1fr' }, (column) => {
    column.spacer('1fr')
    // The game server logs the same banner once it runs
    for (const line of bootBanner({ version: engineVersion ?? 'unknown', mode: 'development' }))
      column.text([{ text: line, fg: theme.primary }], { align: 'center', size: 1 })
    column.spacer(1)
    column.row({ size: 1 }, (row) => {
      row.spacer('1fr')
      // Glyph, space, label
      row.spinner({ label, size: label.length + 2 })
      row.spacer('1fr')
    })
    column.spacer('1fr')
  })

  ui.panel({ title: 'Dev script', size: STARTUP_OUTPUT_LINES + 2 }, (panel) => {
    if (lines.length === 0) {
      panel.label('No output yet')
      return
    }

    panel.log({ entries: lines.slice(-STARTUP_OUTPUT_LINES).map(message => ({ message })), size: '1fr' })
  })
}

function waiting(ui: Container, theme: Theme, state: DashboardState) {
  ui.panel({ title: 'Game server', size: '1fr' }, (panel) => {
    if (state.status === 'connecting') {
      panel.spinner({ label: `Connecting to ${state.source}` })
      return
    }

    panel.text([{ text: STATUS_LABELS[state.status], fg: statusColor(state.status, theme), bold: true }])
    panel.text(state.error ?? '', { wrap: true })
    panel.label(`Retrying (attempt ${state.failures})…`)
  })
}

function wideLayout(ui: Container, theme: Theme, state: DashboardState, snapshot: ServerMetricsSnapshot, view: ViewState, transparent: boolean) {
  ui.grid({ columns: ['1fr', '1fr'], rows: [11, 11], size: 22 }, (grid) => {
    grid.panel({ title: 'CPU' }, p => cpuPanel(p, theme, snapshot))
    grid.panel({ title: 'Network' }, p => networkPanel(p, theme, snapshot))
    grid.panel({ title: 'Tick' }, p => tickPanel(p, theme, snapshot))
    grid.panel({ title: 'World' }, p => worldPanel(p, theme, snapshot))
  })

  ui.row({ size: '1fr' }, (row) => {
    playersPanel(row, theme, snapshot, view, transparent)
    logsPanel(row, theme, state, view)
  })
}

function narrowLayout(ui: Container, theme: Theme, state: DashboardState, snapshot: ServerMetricsSnapshot, view: ViewState, transparent: boolean) {
  ui.panel({ title: 'CPU', size: 9 }, p => cpuPanel(p, theme, snapshot))
  ui.panel({ title: 'Network', size: 9 }, p => networkPanel(p, theme, snapshot))
  ui.panel({ title: 'Tick', size: 9 }, p => tickPanel(p, theme, snapshot))
  ui.panel({ title: 'World', size: 11 }, p => worldPanel(p, theme, snapshot))
  playersPanel(ui, theme, snapshot, view, transparent)
  logsPanel(ui, theme, state, view)
}

function cpuPanel(ui: Container, theme: Theme, { cpu }: ServerMetricsSnapshot) {
  const values = cpu.history.map(h => h.cpuPercentage)

  ui.graph({
    values,
    min: 0,
    max: Math.max(100, ...values),
    fill: true,
    colors: theme.heat,
    axis: true,
    axisFormat: v => `${Math.round(v)}%`,
    size: '1fr',
  })

  ui.meters([
    { label: '1s', value: cpu.avg1s, max: 100, text: formatPercent(cpu.avg1s) },
    { label: '10s', value: cpu.avg10s, max: 100, text: formatPercent(cpu.avg10s) },
    { label: '1m', value: cpu.avg60s, max: 100, text: formatPercent(cpu.avg60s) },
  ], { columns: 3 })
}

function networkPanel(ui: Container, theme: Theme, { bandwidth, sampleIntervalMs }: ServerMetricsSnapshot) {
  const perSecond = 1000 / sampleIntervalMs

  ui.multiGraph([
    { label: 'sent', values: bandwidth.history.map(b => b.sent * perSecond), color: theme.graph[0] },
    { label: 'received', values: bandwidth.history.map(b => b.received * perSecond), color: theme.graph[1] },
  ], {
    min: 0,
    axis: true,
    axisFormat: formatRate,
    legend: true,
    legendAlign: 'right',
    size: '1fr',
  })

  ui.keyValues([
    { label: 'Sent', value: formatRate(bandwidth.sentPerSecond), color: theme.graph[0] },
    { label: 'Received', value: formatRate(bandwidth.receivedPerSecond), color: theme.graph[1] },
  ], { spread: true })
}

function tickPanel(ui: Container, theme: Theme, { tick, tickRate }: ServerMetricsSnapshot) {
  const avg = tick.history.map(t => t.avgMs)
  const max = tick.history.map(t => t.maxMs)
  const latest = tick.latest

  ui.multiGraph([
    { label: 'avg', values: avg, color: theme.graph[0] },
    { label: 'max', values: max, color: theme.graph[2] ?? theme.warning },
  ], {
    min: 0,
    max: Math.max(tick.budgetMs * 1.25, ...max, 1),
    axis: true,
    axisFormat: v => `${v.toFixed(0)}ms`,
    legend: true,
    legendAlign: 'right',
    size: '1fr',
  })

  ui.meter({
    label: 'Budget',
    value: latest?.avgMs ?? 0,
    max: tick.budgetMs || 1,
    text: `${formatMs(latest?.avgMs ?? 0)} / ${formatMs(tick.budgetMs)}`,
  })

  ui.keyValues([
    { label: 'Ticks/s', value: `${latest?.ticksPerSecond ?? 0} / ${tickRate}`, color: (latest?.ticksPerSecond ?? 0) < tickRate * 0.9 ? theme.danger : undefined },
    { label: 'Commands/s', value: `${latest?.commandsPerSecond ?? 0} (max ${latest?.maxCommandsPerTick ?? 0}/tick)` },
  ], { spread: true })
}

function worldPanel(ui: Container, theme: Theme, { players, world, physics, memory }: ServerMetricsSnapshot) {
  ui.keyValues([
    { label: 'Players', value: String(players.length), color: theme.primary },
    { label: 'Entities', value: String(world.entities) },
    { label: 'Physics bodies', value: physics ? String(physics.bodies) : '—' },
    { label: 'Colliders', value: physics ? String(physics.colliders) : '—' },
    { label: 'RSS', value: formatBytes(memory.rss) },
    { label: 'External', value: formatBytes(memory.external) },
  ], { spread: true })

  ui.spacer('1fr')

  ui.meter({
    label: 'Heap',
    value: memory.heapUsed,
    max: memory.heapTotal || 1,
    text: `${formatBytes(memory.heapUsed)} / ${formatBytes(memory.heapTotal)}`,
  })
}

function playersTab(ui: Container, theme: Theme, snapshot: ServerMetricsSnapshot, view: ViewState, transparent: boolean) {
  const selected = snapshot.players.find(p => p.id === view.selectedPlayerId)
  if (!selected) {
    // Nothing picked yet, or the player disconnected
    view.selectedPlayerId = null
    playersPanel(ui, theme, snapshot, view, transparent, true)
    return
  }

  ui.responsive({
    [WIDE_LAYOUT]: c => c.row({ size: '1fr' }, (row) => {
      playersPanel(row, theme, snapshot, view, transparent, true)
      playerDetails(row, theme, selected, 42)
    }),
    0: (c) => {
      playersPanel(c, theme, snapshot, view, transparent, true)
      playerDetails(c, theme, selected, 13)
    },
  })
}

function playerDetails(ui: Container, theme: Theme, player: PlayerRow, size: number) {
  const { connection, position } = player

  ui.panel({ title: player.displayName, size }, (panel) => {
    panel.keyValues([
      { label: 'ID', value: player.id },
      { label: 'Connected', value: formatDuration(player.connectedFor) },
      { label: 'IP', value: connection ? connection.address ?? 'pending' : '—', color: theme.primary },
      { label: 'RTT', value: connection?.rttMs != null ? formatMs(connection.rttMs) : '—' },
      { label: 'Sent', value: connection ? formatBytes(connection.bytesSent) : '—' },
      { label: 'Received', value: connection ? formatBytes(connection.bytesReceived) : '—' },
      { label: 'Position', value: [position.x, position.y, position.z].map(n => n.toFixed(2)).join(', ') },
      { label: 'Last seq', value: String(player.lastProcessedSequenceId) },
      { label: 'Tracked', value: String(player.trackedEntities) },
    ], { spread: true })

    if (!connection)
      panel.label('No live connection (a bot, or an older server)')
  })
}

function playersPanel(ui: Container, theme: Theme, { players }: ServerMetricsSnapshot, view: ViewState, transparent: boolean, selectable = false) {
  const rows = sortedPlayers(players)
  const maxOffset = Math.max(0, rows.length - 1)
  view.playerOffset = Math.min(view.playerOffset, maxOffset)
  // Display names default to the id, so the column only adds noise until a game sets them
  const showNames = rows.some(p => p.displayName !== p.id)

  ui.panel({ title: `Players (${rows.length})`, size: '1fr' }, (panel) => {
    if (rows.length === 0) {
      panel.label('No players connected')
      return
    }

    panel.table<PlayerRow>({
      rows,
      offset: view.playerOffset,
      selected: selectable ? rows.findIndex(p => p.id === view.selectedPlayerId) : -1,
      followSelection: selectable && view.followSelectedPlayer,
      // Following the selection can move the window, so keep our offset in step with what is drawn
      onRow: (_row, index, y) => {
        if (y === 1)
          view.playerOffset = index
      },
      onSelectRow: selectable
        ? (visibleRow) => {
            const row = rows[view.playerOffset + visibleRow]
            if (!row)
              return
            view.selectedPlayerId = row.id === view.selectedPlayerId ? null : row.id
            ui.ctx.invalidate()
          }
        : undefined,
      scrollbar: true,
      // Zebra stripes are solid fills, which would break transparency
      zebra: !transparent,
      size: '1fr',
      onScroll: (delta) => {
        view.playerOffset = Math.max(0, Math.min(maxOffset, view.playerOffset + delta))
        view.followSelectedPlayer = false
        ui.ctx.invalidate()
      },
      columns: [
        ...(showNames ? [{ key: 'displayName', title: 'Name' }] : []),
        { key: 'id', title: 'ID' },
        { key: 'x', title: 'X', width: 9, align: 'right', render: p => p.position.x.toFixed(2) },
        { key: 'y', title: 'Y', width: 9, align: 'right', render: p => p.position.y.toFixed(2) },
        { key: 'z', title: 'Z', width: 9, align: 'right', render: p => p.position.z.toFixed(2) },
        { key: 'lastProcessedSequenceId', title: 'Seq', width: 10, align: 'right' },
        { key: 'trackedEntities', title: 'Tracked', width: 8, align: 'right' },
      ],
    })
  })
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => n.toString().padStart(2, '0')).join(':')
}

/**
 * One widget row per line. Multi-line messages (like the boot banner) continue
 * on rows without a time or level, and blank lines around them are dropped.
 */
export function toLogRows(lines: LogLine[]) {
  return lines.flatMap(({ timestamp, level, message }) => {
    const parts = message.split(NEWLINE_RE)
    while (parts.length > 1 && parts[0].trim() === '')
      parts.shift()
    while (parts.length > 1 && parts.at(-1)!.trim() === '')
      parts.pop()

    return parts.map((part, i) => i === 0
      ? { time: formatTime(timestamp), level, message: part }
      : { message: `${' '.repeat(15)}${part}` })
  })
}

function logsPanel(ui: Container, theme: Theme, state: DashboardState, view: ViewState) {
  const rows = toLogRows(state.logs)
  view.logFromEnd = Math.min(view.logFromEnd, Math.max(0, rows.length - 1))

  const title = view.logFromEnd > 0 ? `Logs (scrolled back ${view.logFromEnd}, scroll down to follow)` : 'Logs'

  ui.panel({ title, size: '1fr' }, (panel) => {
    if (state.logsAvailable === false) {
      panel.label('Not available: the server runs a @mavonengine/core release without GET /api/game/logs, or has metrics.logBufferSize set to 0')
      return
    }

    if (rows.length === 0) {
      panel.label('No log output yet')
      return
    }

    panel.log({
      entries: rows,
      fromEnd: view.logFromEnd,
      scrollbar: true,
      size: '1fr',
      levelColors: {
        VERBOSE: theme.muted,
        SILLY: theme.muted,
        HTTP: theme.info,
      },
      onScroll: (delta) => {
        view.logFromEnd = Math.max(0, Math.min(rows.length - 1, view.logFromEnd - delta * 3))
        ui.ctx.invalidate()
      },
    })
  })
}
