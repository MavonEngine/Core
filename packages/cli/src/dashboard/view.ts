import type { InstallJob } from '@mavonengine/core/Plugins/install'
import type { AvailablePlugin } from '@mavonengine/core/Plugins/registry'
import type { Color, Container, Span, Theme } from '@profullstack/hqtui'
import type AvailablePlugins from './available'
import type { ConnectionStatus, DashboardState } from './MetricsClient'
import type { DatabaseInfo, DatabaseTableLine, LogLine, PacketDetail, PacketLine, PlayerAccount, PluginLine, RequestLine, RouteLine, ServerMetricsSnapshot, SyncPlayerLine } from './snapshot'
import { stripVTControlCharacters } from 'node:util'
import { notInProject } from '@mavonengine/core/Plugins/registry'
import { bootBanner } from '@mavonengine/core/Utils/BootBanner'
import { DEFAULT_COLOR, hex } from '@profullstack/hqtui'
import { formatBytes, formatDuration, formatMs, formatPercent, formatRate } from './format'
import { LOGO_SIZES } from './logo'
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
  /** Request at the top of the HTTP table while scrolled, null follows the newest */
  requestTopId: number | null
  /** Packet at the top of the Network table while scrolled, null follows the newest */
  packetTopId: number | null
  /** Show ping / pong on the Network tab: one pair a second per client */
  showPings: boolean
  /** Only show network events on the Network tab, not the packets */
  eventsOnly: boolean
  /** Packet whose content shows in the details panel on the Network tab */
  selectedPacketId: number | null
  /** Keep the selected packet on screen; off while the mouse wheel scrolls the table */
  followSelectedPacket: boolean
  /** First line of the payload shown in the details panel */
  payloadOffset: number
  /** Rows the Routes table is scrolled down by */
  routeOffset?: number
  /** Package of the plugin shown in the details on the Plugins tab, the first one while unset */
  selectedPlugin?: string | null
  /** Package the Plugins tab asks to confirm the install of, unset when it asks nothing */
  confirmInstall?: string | null
  /** Table whose rows the Database tab shows, the first one while unset */
  selectedTable?: string | null
  /** First row of that table shown */
  tableOffset?: number
  /** How many of its rows fit on screen, as last drawn: what left and right page by */
  tableVisibleRows?: number
}

/** What the dashboard needs of the installer `mavonengine dev` gives it */
export interface DashboardInstaller {
  /** The running or last install */
  readonly job: InstallJob | null
  readonly busy: boolean
}

export function initialViewState(): ViewState {
  return {
    tab: 0,
    playerOffset: 0,
    logFromEnd: 0,
    requestTopId: null,
    selectedPlayerId: null,
    followSelectedPlayer: true,
    packetTopId: null,
    showPings: false,
    eventsOnly: false,
    selectedPacketId: null,
    followSelectedPacket: true,
    payloadOffset: 0,
  }
}

export interface RenderOptions {
  /**
   * Leave cells on the terminal's default background so a transparent terminal shows through.
   * Text is only as readable as whatever is behind the window.
   */
  transparent?: boolean
  /** Show the `o` key that opens the game in the browser */
  openKey?: boolean
  /** Set while `mavonengine dev` or `mavonengine create` waits for the game server it started */
  startup?: StartupInfo
  /** The plugins that can be installed, shown on the Plugins tab and fetched when it is first drawn */
  available?: AvailablePlugins
  /** Set under `mavonengine dev`: plugins can be installed from the Plugins tab */
  installer?: DashboardInstaller
}

export interface StartupInfo {
  /** The project's @mavonengine/core version, if it is installed */
  engineVersion?: string
  /** What the dev script printed so far */
  output: string
  /** Under the banner, default 'Starting the game server…' */
  label?: string
  /** Of the output panel, default 'Dev script' */
  outputTitle?: string
}

type PlayerRow = ServerMetricsSnapshot['players'][number]

/** An account in a table cell: its name, marked when it is a guest. A dash without one */
export function accountLabel(account: PlayerAccount | null | undefined): string {
  if (!account)
    return '—'
  const name = account.name ?? account.id
  return account.guest
    ? `${name} (guest)`
    : name
}

export const DASHBOARD_TABS = [
  'Overview',
  'Players',
  'Logs',
  'HTTP',
  'Network',
  'Routes',
  'Plugins',
  'Database',
] as const

/** What left and right page by before the rows were drawn */
const DEFAULT_VISIBLE_ROWS = 20

/** Whether the tab showing needs the database, which is only fetched for it */
export function showsDatabase(view: ViewState): boolean {
  return DASHBOARD_TABS[view.tab] === 'Database'
}

/** The table the Database tab shows: the one picked, else the first */
export function selectedTable(view: ViewState, database: DatabaseInfo | null): DatabaseTableLine | undefined {
  const tables = database?.tables ?? []
  return tables.find(t => t.name === view.selectedTable) ?? tables[0]
}

/**
 * Keys of the Database tab: arrow keys / j k pick a table, left and right (or page up and down) page through its rows.
 * Returns whether the key was used.
 */
export function handleDatabaseKey(view: ViewState, database: DatabaseInfo | null, key: string, pageRows = view.tableVisibleRows || DEFAULT_VISIBLE_ROWS): boolean {
  if (!showsDatabase(view))
    return false

  const tables = database?.tables ?? []
  const shown = selectedTable(view, database)
  if (!shown)
    return false

  const delta = key === 'down' || key === 'j'
    ? 1
    : key === 'up' || key === 'k'
      ? -1
      : 0
  if (delta !== 0) {
    const next = tables[Math.max(0, Math.min(tables.length - 1, tables.indexOf(shown) + delta))]
    if (next.name === shown.name)
      return false
    view.selectedTable = next.name
    view.tableOffset = 0
    return true
  }

  const page = key === 'right' || key === 'pagedown'
    ? 1
    : key === 'left' || key === 'pageup'
      ? -1
      : 0
  if (page === 0)
    return false

  const offset = view.tableOffset ?? 0
  // The last page shows the last rows, as many as fit
  const last = shown.rows === null
    ? Infinity
    : Math.max(0, shown.rows - pageRows)
  const next = Math.max(0, Math.min(last, offset + page * pageRows))
  if (next === offset)
    return false
  view.selectedTable = shown.name
  view.tableOffset = next
  return true
}

/** Whether the tab showing needs the packets and the state sync, which are only fetched for it */
export function showsNetwork(view: ViewState): boolean {
  return DASHBOARD_TABS[view.tab] === 'Network'
}

/** How far back the "By message" table of the Network tab looks, in ms */
export const MESSAGE_STATS_WINDOW_MS = 5000

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
 * The tabs to show: the Database tab only while the server says it has a database plugin.
 * It is the last tab, so the others keep their number keys either way.
 */
export function dashboardTabs(state: Pick<DashboardState, 'plugins'>): readonly (typeof DASHBOARD_TABS)[number][] {
  return state.plugins.some(plugin => plugin.database)
    ? DASHBOARD_TABS
    : DASHBOARD_TABS.filter(tab => tab !== 'Database')
}

/**
 * The tab a number key switches to, or null if the key isn't one.
 */
export function tabForKey(key: string, tabCount: number = DASHBOARD_TABS.length): number | null {
  const index = Number(key) - 1
  return Number.isInteger(index) && index >= 0 && index < Math.min(tabCount, DASHBOARD_TABS.length)
    ? index
    : null
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

  const delta = key === 'down' || key === 'j'
    ? 1
    : key === 'up' || key === 'k'
      ? -1
      : 0
  const rows = sortedPlayers(snapshot.players)
  if (delta === 0 || rows.length === 0)
    return false

  const current = rows.findIndex(p => p.id === view.selectedPlayerId)
  const next = current === -1
    ? (delta > 0
        ? 0
        : rows.length - 1)
    : Math.max(0, Math.min(rows.length - 1, current + delta))

  view.selectedPlayerId = rows[next].id
  view.followSelectedPlayer = true
  return true
}

/** Open a packet in the details panel of the Network tab, or close the panel with null */
function selectPacket(view: ViewState, id: number | null) {
  view.selectedPacketId = id
  view.payloadOffset = 0
  view.followSelectedPacket = true
}

/**
 * Keys of the Network tab: `p` shows or hides pings, `e` switches to events only, arrow keys / j k open
 * the next packet in the list (down is older, as listed) and escape closes it.
 * Returns whether the key was used.
 */
export function handleNetworkKey(view: ViewState, key: string, packets: PacketLine[] = []): boolean {
  if (!showsNetwork(view))
    return false

  if (key === 'escape') {
    const had = view.selectedPacketId !== null
    selectPacket(view, null)
    return had
  }

  const delta = key === 'down' || key === 'j'
    ? 1
    : key === 'up' || key === 'k'
      ? -1
      : 0
  if (delta !== 0) {
    // Newest first, as the table lists them
    const rows = visiblePackets(packets, view).reverse()
    if (rows.length === 0)
      return false

    const current = rows.findIndex(p => p.id === view.selectedPacketId)
    const next = current === -1
      ? (delta > 0
          ? 0
          : rows.length - 1)
      : Math.max(0, Math.min(rows.length - 1, current + delta))
    selectPacket(view, rows[next].id)
    return true
  }

  if (key === 'p')
    view.showPings = !view.showPings
  else if (key === 'e')
    view.eventsOnly = !view.eventsOnly
  else
    return false

  // The rows changed, so the scroll anchor may no longer be among them
  view.packetTopId = null
  return true
}

export interface MessageStat {
  direction: 'in' | 'out'
  type: string
  /** Packets per second */
  rate: number
  bytesPerSecond: number
  avgBytes: number
}

/**
 * What the traffic is made of: packets per message name and direction over the last `windowMs`
 * before the newest record, largest share of the bandwidth first.
 */
export function messageStats(packets: PacketLine[], windowMs = MESSAGE_STATS_WINDOW_MS): MessageStat[] {
  const newest = packets.at(-1)?.timestamp
  if (newest === undefined)
    return []

  const recent = packets.filter(p => p.kind === 'packet' && p.direction && p.timestamp > newest - windowMs)
  // A server that just started has less than the window to show
  const seconds = Math.max(1000, Math.min(windowMs, newest - (packets[0]?.timestamp ?? newest))) / 1000

  const groups = new Map<string, { direction: 'in' | 'out', type: string, count: number, bytes: number }>()
  for (const packet of recent) {
    const key = `${packet.direction} ${packet.type}`
    const group = groups.get(key) ?? {
      direction: packet.direction!,
      type: packet.type,
      count: 0,
      bytes: 0,
    }
    group.count++
    group.bytes += packet.bytes
    groups.set(key, group)
  }

  return Array.from(groups.values(), ({ direction, type, count, bytes }) => ({
    direction,
    type,
    rate: count / seconds,
    bytesPerSecond: bytes / seconds,
    avgBytes: bytes / count,
  }))
    .sort((a, b) => b.bytesPerSecond - a.bytesPerSecond || b.rate - a.rate || a.type.localeCompare(b.type))
}

/** The facts of a packet or event in one line: tick, sequence id and what its `info` holds */
export function describePacket(packet: PacketLine): string {
  const parts: string[] = []
  if (packet.tick !== null)
    parts.push(`tick ${packet.tick}`)
  if (packet.sequenceId !== null)
    parts.push(`seq ${packet.sequenceId}`)
  if (packet.reliable)
    parts.push('reliable')

  for (const [key, value] of Object.entries(packet.info)) {
    if (value === undefined || value === null)
      continue
    parts.push(`${key} ${Array.isArray(value)
      ? value.join(', ')
      : typeof value === 'object'
        ? JSON.stringify(value)
        : String(value)}`)
  }

  return parts.join(' · ')
}

/** The plugins of the public list the project doesn't have, once the list was read */
function installable(plugins: PluginLine[], available?: AvailablePlugins): AvailablePlugin[] {
  return available
    ? notInProject(available.state.plugins, plugins.map(p => p.package))
    : []
}

/**
 * The plugin the Plugins tab shows: one of the project's or one that can be installed.
 * Nothing picked yet shows the project's first one, or the first one to install when it has none.
 */
export function selectedPlugin(view: ViewState, plugins: PluginLine[], rest: AvailablePlugin[] = []): { installed?: PluginLine, available?: AvailablePlugin } {
  const installed = plugins.find(p => p.package === view.selectedPlugin)
  if (installed)
    return { installed }

  const available = rest.find(p => p.package === view.selectedPlugin)
  if (available)
    return { available }

  return plugins.length
    ? { installed: plugins[0] }
    : { available: rest[0] }
}

/**
 * Arrow keys / j k move the plugin selection on the Plugins tab, through the project's plugins and on
 * into the ones that can be installed. Returns whether the key was used.
 */
export function handlePluginsKey(view: ViewState, plugins: PluginLine[], key: string, rest: AvailablePlugin[] = []): boolean {
  if (DASHBOARD_TABS[view.tab] !== 'Plugins' || view.confirmInstall)
    return false

  const delta = key === 'down' || key === 'j'
    ? 1
    : key === 'up' || key === 'k'
      ? -1
      : 0
  const packages = [
    ...plugins,
    ...rest,
  ].map(p => p.package)
  if (delta === 0 || packages.length === 0)
    return false

  const shown = selectedPlugin(view, plugins, rest)
  const current = Math.max(0, packages.indexOf((shown.installed ?? shown.available)!.package))
  view.selectedPlugin = packages[Math.max(0, Math.min(packages.length - 1, current + delta))]
  return true
}

/**
 * The keys that install a plugin from the Plugins tab: `i` asks whether to install the selected one,
 * then `y` installs it and `n` or escape doesn't. Returns the package to install now, true when the key
 * was used otherwise, false when it wasn't.
 */
export function handleInstallKey(view: ViewState, plugins: PluginLine[], key: string, rest: AvailablePlugin[], installer?: DashboardInstaller): string | boolean {
  if (DASHBOARD_TABS[view.tab] !== 'Plugins' || !installer)
    return false

  if (view.confirmInstall) {
    const pkg = view.confirmInstall
    if (key === 'y') {
      view.confirmInstall = null
      return installer.busy ? true : pkg
    }
    if (key === 'n' || key === 'escape') {
      view.confirmInstall = null
      return true
    }
    return false
  }

  const { available } = selectedPlugin(view, plugins, rest)
  if (key !== 'i' || !available || installer.busy)
    return false

  view.confirmInstall = available.package
  return true
}

function pluginKeys(state: DashboardState, view: ViewState, available?: AvailablePlugins, installer?: DashboardInstaller) {
  if (view.confirmInstall) {
    return [
      { key: 'y', label: 'Install' },
      { key: 'n', label: 'Cancel' },
    ]
  }

  const rest = installable(state.plugins, available)
  return [
    ...(state.plugins.length + rest.length > 1
      ? [
          { key: '↑↓', label: 'Select plugin' },
        ]
      : []),
    ...(installer && !installer.busy && selectedPlugin(view, state.plugins, rest).available
      ? [
          { key: 'i', label: 'Install' },
        ]
      : []),
  ]
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
export function renderDashboard(ui: Container, theme: Theme, state: DashboardState, view: ViewState, { transparent = false, startup, openKey = false, available, installer }: RenderOptions = {}) {
  const { snapshot } = state
  const starting = !snapshot && !!startup && (state.status === 'connecting' || state.status === 'unreachable')
  const tabs = dashboardTabs(state)

  ui.column({}, (root) => {
    header(root, theme, state)

    if (snapshot?.latencySimulation)
      latencyBanner(root, theme, snapshot.latencySimulation)

    if (state.error && snapshot) {
      root.text([
        { text: ` ${state.error} — showing last known values`, fg: theme.danger },
      ], { size: 1 })
    }

    if (starting) {
      startupScreen(root, theme, startup!)
    }
    else if (!snapshot) {
      waiting(root, theme, state)
    }
    else {
      // The Database tab went away, e.g. the server restarted without its database plugin
      if (view.tab >= tabs.length)
        view.tab = 0

      root.tabs({
        tabs: tabs.map((name, i) => `${i + 1} ${name}`),
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
      else if (tab === 'HTTP') {
        requestsPanel(root, theme, state, view, transparent)
      }
      else if (tab === 'Network') {
        networkTab(root, theme, state, view, transparent)
      }
      else if (tab === 'Routes') {
        routesPanel(root, theme, state, view, transparent)
      }
      else if (tab === 'Plugins') {
        pluginsTab(root, theme, state, view, transparent, available, installer)
      }
      else if (tab === 'Database') {
        databaseTab(root, theme, state, view, transparent)
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
        { key: `1-${tabs.length}`, label: 'Tabs' },
        ...(openKey && snapshot
          ? [
              { key: 'o', label: 'Open game' },
            ]
          : []),
        ...(snapshot && DASHBOARD_TABS[view.tab] === 'Players'
          ? [
              { key: '↑↓', label: 'Select player' },
              ...(view.selectedPlayerId
                ? [
                    { key: 'esc', label: 'Close' },
                  ]
                : []),
            ]
          : []),
        ...(snapshot && showsNetwork(view)
          ? [
              {
                key: 'p',
                label: view.showPings ? 'Hide pings' : 'Show pings',
              },
              {
                key: 'e',
                label: view.eventsOnly ? 'All records' : 'Events only',
              },
              { key: '↑↓', label: 'Open packet' },
              ...(view.selectedPacketId !== null
                ? [
                    { key: 'esc', label: 'Close' },
                  ]
                : []),
            ]
          : []),
        ...(snapshot && DASHBOARD_TABS[view.tab] === 'Plugins'
          ? pluginKeys(state, view, available, installer)
          : []),
        ...(snapshot && showsDatabase(view) && state.database?.tables.length
          ? [
              ...(state.database.tables.length > 1
                ? [
                    { key: '↑↓', label: 'Select table' },
                  ]
                : []),
              { key: '←→', label: 'Page rows' },
            ]
          : []),
      ],
      right: [
        starting
          ? {
              label: 'STARTING',
              color: statusColor('connecting', theme),
            }
          : {
              label: STATUS_LABELS[state.status],
              color: statusColor(state.status, theme),
              active: state.status === 'live',
            },
      ],
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
      {
        text: formatDuration(state.snapshot.uptime),
      },
      { text: '  engine ', fg: theme.muted },
      { text: state.snapshot.engineVersion },
    )

    if (state.snapshot.schemaVersion > SUPPORTED_SCHEMA_VERSION)
      spans.push({ text: '  newer metrics schema, update @mavonengine/cli', fg: theme.warning })
  }

  ui.text(spans, { size: 1 })
}

function latencyBanner(ui: Container, theme: Theme, latency: NonNullable<ServerMetricsSnapshot['latencySimulation']>) {
  ui.text([
    {
      text: ` LATENCY SIMULATION ON  ${latency.fixedLatency}ms ± ${latency.jitter / 2}ms, ${formatPercent(latency.packetLoss * 100)} packet loss `,
      fg: theme.background,
      bg: theme.warning,
      bold: true,
    },
  ], { size: 1 })
}

/** Dev script output lines shown under the banner while the server starts */
const STARTUP_OUTPUT_LINES = 8

/**
 * Pixel rows drawn two to a line: the top pixel is the glyph, the bottom one its background.
 * Cut-out pixels keep the terminal's background, so the logo works on any theme.
 */
function logoLines(pixels: string[]): Span[][] {
  const pixel = (row: string | undefined, x: number) => {
    const value = row?.slice(x * 6, x * 6 + 6)
    return value && value !== '------'
      ? hex(Number.parseInt(value, 16))
      : null
  }

  const lines: Span[][] = []
  for (let y = 0; y < pixels.length; y += 2) {
    const line: Span[] = []
    for (let x = 0; x < pixels[y].length / 6; x++) {
      const top = pixel(pixels[y], x)
      const bottom = pixel(pixels[y + 1], x)
      if (top !== null)
        line.push({ text: '▀', fg: top, bg: bottom ?? undefined })
      else if (bottom !== null)
        line.push({ text: '▄', fg: bottom })
      else
        line.push({ text: ' ' })
    }
    lines.push(line)
  }

  return lines
}

const LOGOS = LOGO_SIZES.map(logoLines)

function startupScreen(ui: Container, theme: Theme, { engineVersion, output, label = 'Starting the game server…', outputTitle = 'Dev script' }: StartupInfo) {
  const lines = stripVTControlCharacters(output).split(NEWLINE_RE).filter(line => line.trim() !== '')
  // The game server logs the same banner once it runs
  const banner = bootBanner({ version: engineVersion ?? 'unknown', mode: 'development' })

  ui.column({ size: '1fr' }, (column) => {
    const { unicode, colors } = column.ctx.capabilities
    // Banner, the spacers around it and the spinner have to fit too. Too few colours make a smudge.
    const logo = unicode && (colors === 'truecolor' || colors === 'ansi256')
      ? LOGOS.find(l => l.length + banner.length + 3 <= column.height && l[0].length <= column.width)
      : undefined

    column.spacer('1fr')
    if (logo) {
      for (const line of logo)
        column.text(line, { align: 'center', size: 1 })
      column.spacer(1)
    }
    for (const line of banner) {
      column.text([
        { text: line, fg: theme.primary },
      ], { align: 'center', size: 1 })
    }
    column.spacer(1)
    column.row({ size: 1 }, (row) => {
      row.spacer('1fr')
      // Glyph, space, label
      row.spinner({ label, size: label.length + 2 })
      row.spacer('1fr')
    })
    column.spacer('1fr')
  })

  ui.panel({ title: outputTitle, size: STARTUP_OUTPUT_LINES + 2 }, (panel) => {
    if (lines.length === 0) {
      panel.label('No output yet')
      return
    }

    panel.log({
      entries: lines.slice(-STARTUP_OUTPUT_LINES).map(message => ({ message })),
      size: '1fr',
    })
  })
}

function waiting(ui: Container, theme: Theme, state: DashboardState) {
  ui.panel({ title: 'Game server', size: '1fr' }, (panel) => {
    if (state.status === 'connecting') {
      panel.spinner({ label: `Connecting to ${state.source}` })
      return
    }

    panel.text([
      {
        text: STATUS_LABELS[state.status],
        fg: statusColor(state.status, theme),
        bold: true,
      },
    ])
    panel.text(state.error ?? '', { wrap: true })
    panel.label(`Retrying (attempt ${state.failures})…`)
  })
}

function wideLayout(ui: Container, theme: Theme, state: DashboardState, snapshot: ServerMetricsSnapshot, view: ViewState, transparent: boolean) {
  if (snapshot.queue) {
    ui.grid({
      columns: ['1fr', '1fr', '1fr'],
      rows: [11, 11],
      size: 22,
    }, (grid) => {
      grid.panel({ title: 'CPU' }, p => cpuPanel(p, theme, snapshot))
      grid.panel({ title: 'Network' }, p => networkPanel(p, theme, snapshot))
      grid.panel({ title: 'Tick' }, p => tickPanel(p, theme, snapshot))
      grid.panel({
        title: queueTitle(snapshot.queue!),
        colSpan: 2,
      }, p => queuePanel(p, theme, snapshot.queue!))
      grid.panel({ title: 'World' }, p => worldPanel(p, theme, snapshot))
    })
  }
  else {
    ui.grid({
      columns: ['1fr', '1fr'],
      rows: [11, 11],
      size: 22,
    }, (grid) => {
      grid.panel({ title: 'CPU' }, p => cpuPanel(p, theme, snapshot))
      grid.panel({ title: 'Network' }, p => networkPanel(p, theme, snapshot))
      grid.panel({ title: 'Tick' }, p => tickPanel(p, theme, snapshot))
      grid.panel({ title: 'World' }, p => worldPanel(p, theme, snapshot))
    })
  }

  ui.row({ size: '1fr' }, (row) => {
    playersPanel(row, theme, snapshot, view, transparent)
    logsPanel(row, theme, state, view)
  })
}

function narrowLayout(ui: Container, theme: Theme, state: DashboardState, snapshot: ServerMetricsSnapshot, view: ViewState, transparent: boolean) {
  ui.panel({ title: 'CPU', size: 9 }, p => cpuPanel(p, theme, snapshot))
  ui.panel({ title: 'Network', size: 9 }, p => networkPanel(p, theme, snapshot))
  ui.panel({ title: 'Tick', size: 9 }, p => tickPanel(p, theme, snapshot))
  if (snapshot.queue) {
    ui.panel({
      title: queueTitle(snapshot.queue),
      size: 9,
    }, p => queuePanel(p, theme, snapshot.queue!))
  }
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
    {
      label: '1s',
      value: cpu.avg1s,
      max: 100,
      text: formatPercent(cpu.avg1s),
    },
    {
      label: '10s',
      value: cpu.avg10s,
      max: 100,
      text: formatPercent(cpu.avg10s),
    },
    {
      label: '1m',
      value: cpu.avg60s,
      max: 100,
      text: formatPercent(cpu.avg60s),
    },
  ], { columns: 3 })
}

function networkPanel(ui: Container, theme: Theme, { bandwidth, sampleIntervalMs }: ServerMetricsSnapshot) {
  const perSecond = 1000 / sampleIntervalMs

  ui.multiGraph([
    {
      label: 'sent',
      values: bandwidth.history.map(b => b.sent * perSecond),
      color: theme.graph[0],
    },
    {
      label: 'received',
      values: bandwidth.history.map(b => b.received * perSecond),
      color: theme.graph[1],
    },
  ], {
    min: 0,
    axis: true,
    axisFormat: formatRate,
    legend: true,
    legendAlign: 'right',
    size: '1fr',
  })

  ui.keyValues([
    {
      label: 'Sent',
      value: formatRate(bandwidth.sentPerSecond),
      color: theme.graph[0],
    },
    {
      label: 'Received',
      value: formatRate(bandwidth.receivedPerSecond),
      color: theme.graph[1],
    },
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
    {
      label: 'Ticks/s',
      value: `${latest?.ticksPerSecond ?? 0} / ${tickRate}`,
      color: (latest?.ticksPerSecond ?? 0) < tickRate * 0.9
        ? theme.danger
        : undefined,
    },
    { label: 'Commands/s', value: `${latest?.commandsPerSecond ?? 0} (max ${latest?.maxCommandsPerTick ?? 0}/tick)` },
  ], { spread: true })
}

type QueueMetrics = NonNullable<ServerMetricsSnapshot['queue']>

/** `Queue (database)`, and says so when this server doesn't run its jobs */
export function queueTitle(queue: QueueMetrics): string {
  return `Queue (${queue.driver}${queue.working ? '' : ', not worked here'})`
}

/** Jobs over the whole history: what the panel's totals show */
export function queueTotals(queue: QueueMetrics): { processed: number, failed: number, retried: number } {
  return queue.history.reduce((sum, s) => ({ processed: sum.processed + s.processed, failed: sum.failed + s.failed, retried: sum.retried + s.retried }), { processed: 0, failed: 0, retried: 0 })
}

function queuePanel(ui: Container, theme: Theme, queue: QueueMetrics) {
  const latest = queue.latest
  const totals = queueTotals(queue)
  const seconds = Math.round(queue.history.length > 1
    ? (queue.history.at(-1)!.timestamp - queue.history[0].timestamp) / 1000
    : 0)
  const window = seconds >= 60
    ? `${Math.round(seconds / 60)}m`
    : `${seconds}s`

  ui.multiGraph([
    {
      label: 'queued',
      values: queue.history.map(s => s.size),
      color: theme.graph[0],
    },
    {
      label: 'processed',
      values: queue.history.map(s => s.processed),
      color: theme.graph[1],
    },
    {
      label: 'failed',
      values: queue.history.map(s => s.failed),
      color: theme.danger,
    },
  ], {
    min: 0,
    max: Math.max(4, ...queue.history.map(s => Math.max(s.size, s.processed, s.failed))),
    axis: true,
    axisFormat: v => String(Math.round(v)),
    legend: true,
    legendAlign: 'right',
    size: '1fr',
  })

  ui.keyValues([
    {
      label: 'Queued',
      value: String(latest?.size ?? 0),
      color: theme.graph[0],
    },
    {
      label: 'Running',
      value: String(latest?.running ?? 0),
    },
    {
      label: `Processed ${window}`,
      value: String(totals.processed),
      color: theme.graph[1],
    },
    {
      label: `Retried ${window}`,
      value: String(totals.retried),
      color: totals.retried ? theme.warning : undefined,
    },
    {
      label: `Failed ${window}`,
      value: String(totals.failed),
      color: totals.failed ? theme.danger : undefined,
    },
  ], { spread: true })
}

function worldPanel(ui: Container, theme: Theme, { players, world, physics, memory }: ServerMetricsSnapshot) {
  ui.keyValues([
    {
      label: 'Players',
      value: String(players.length),
      color: theme.primary,
    },
    {
      label: 'Entities',
      value: String(world.entities),
    },
    {
      label: 'Physics bodies',
      value: physics
        ? String(physics.bodies)
        : '—',
    },
    {
      label: 'Colliders',
      value: physics
        ? String(physics.colliders)
        : '—',
    },
    {
      label: 'RSS',
      value: formatBytes(memory.rss),
    },
    {
      label: 'External',
      value: formatBytes(memory.external),
    },
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
      {
        label: 'Account',
        value: player.account
          ? `${accountLabel(player.account)} · ${player.account.id}`
          : 'none',
        color: player.account?.guest ? theme.warning : undefined,
      },
      {
        label: 'Connected',
        value: formatDuration(player.connectedFor),
      },
      {
        label: 'IP',
        value: connection
          ? connection.address ?? 'pending'
          : '—',
        color: theme.primary,
      },
      {
        label: 'RTT',
        value: connection?.rttMs != null
          ? formatMs(connection.rttMs)
          : '—',
      },
      {
        label: 'Sent',
        value: connection
          ? formatBytes(connection.bytesSent)
          : '—',
      },
      {
        label: 'Received',
        value: connection
          ? formatBytes(connection.bytesReceived)
          : '—',
      },
      {
        label: 'Position',
        value: [position.x, position.y, position.z].map(n => n.toFixed(2)).join(', '),
      },
      {
        label: 'Last seq',
        value: String(player.lastProcessedSequenceId),
      },
      {
        label: 'Tracked',
        value: String(player.trackedEntities),
      },
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
  // Only servers with an auth plugin know who their players are
  const showAccounts = rows.some(p => p.account)

  ui.panel({ title: `Players (${rows.length})`, size: '1fr' }, (panel) => {
    if (rows.length === 0) {
      panel.label('No players connected')
      return
    }

    panel.table<PlayerRow>({
      rows,
      offset: view.playerOffset,
      selected: selectable
        ? rows.findIndex(p => p.id === view.selectedPlayerId)
        : -1,
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
            view.selectedPlayerId = row.id === view.selectedPlayerId
              ? null
              : row.id
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
        ...(showNames
          ? [
              { key: 'displayName', title: 'Name' },
            ]
          : []),
        ...(showAccounts
          ? [
              {
                key: 'account',
                title: 'Account',
                render: (p: PlayerRow) => accountLabel(p.account),
                color: (p: PlayerRow) => p.account?.guest ? theme.warning : undefined,
              },
            ]
          : []),
        { key: 'id', title: 'ID' },
        {
          key: 'x',
          title: 'X',
          width: 9,
          align: 'right',
          render: p => p.position.x.toFixed(2),
        },
        {
          key: 'y',
          title: 'Y',
          width: 9,
          align: 'right',
          render: p => p.position.y.toFixed(2),
        },
        {
          key: 'z',
          title: 'Z',
          width: 9,
          align: 'right',
          render: p => p.position.z.toFixed(2),
        },
        {
          key: 'lastProcessedSequenceId',
          title: 'Seq',
          width: 10,
          align: 'right',
        },
        {
          key: 'trackedEntities',
          title: 'Tracked',
          width: 8,
          align: 'right',
        },
      ],
    })
  })
}

function formatTime(timestamp: number) {
  const date = new Date(timestamp)
  return [
    date.getHours(),
    date.getMinutes(),
    date.getSeconds(),
  ].map(n => n.toString().padStart(2, '0')).join(':')
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
      ? {
          time: formatTime(timestamp),
          level,
          message: part,
        }
      : { message: `${' '.repeat(15)}${part}` })
  })
}

function logsPanel(ui: Container, theme: Theme, state: DashboardState, view: ViewState) {
  const rows = toLogRows(state.logs)
  view.logFromEnd = Math.min(view.logFromEnd, Math.max(0, rows.length - 1))

  const title = view.logFromEnd > 0
    ? `Logs (scrolled back ${view.logFromEnd}, scroll down to follow)`
    : 'Logs'

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

function statusCodeColor(status: number | null, theme: Theme): Color | undefined {
  if (status === null || status >= 500)
    return theme.danger
  if (status >= 400)
    return theme.warning
  if (status >= 300)
    return theme.info
  return theme.success
}

function requestsPanel(ui: Container, theme: Theme, state: DashboardState, view: ViewState, transparent: boolean) {
  // Newest first, so new requests appear at the top without scrolling
  const rows = [...state.requests].reverse()
  // Anchored to a request rather than a row number, so arriving requests don't move a scrolled table
  const anchor = view.requestTopId === null
    ? 0
    : rows.findIndex(r => r.id <= view.requestTopId!)
  const offset = Math.max(0, anchor)
  const errors = rows.filter(r => r.status === null || r.status >= 400).length

  const title = `HTTP requests (${rows.length}${errors
    ? `, ${errors} error${errors === 1
      ? ''
      : 's'}`
    : ''})${offset > 0
    ? ', scroll up to follow'
    : ''}`

  ui.panel({ title, size: '1fr' }, (panel) => {
    if (state.requestsAvailable === false) {
      panel.label('Not available: the server runs a @mavonengine/core release without GET /api/game/requests, or has metrics.requestLogSize set to 0')
      return
    }

    if (rows.length === 0) {
      panel.label('No requests yet')
      return
    }

    panel.table<RequestLine>({
      rows,
      offset,
      scrollbar: true,
      // Zebra stripes are solid fills, which would break transparency
      zebra: !transparent,
      size: '1fr',
      // The table won't scroll past the last full page, so keep the anchor on the row it actually drew
      onRow: (_row, index, y) => {
        if (y === 1) {
          view.requestTopId = index === 0
            ? null
            : rows[index].id
        }
      },
      onScroll: (delta) => {
        const next = Math.max(0, Math.min(rows.length - 1, offset + delta))
        view.requestTopId = next === 0
          ? null
          : rows[next].id
        ui.ctx.invalidate()
      },
      columns: [
        {
          key: 'time',
          title: 'Time',
          width: 8,
          color: theme.muted,
          render: r => formatTime(r.timestamp),
        },
        {
          key: 'method',
          title: 'Method',
          width: 7,
          color: r => r.method === 'WS'
            ? theme.primary
            : undefined,
        },
        {
          key: 'status',
          title: 'Status',
          width: 6,
          align: 'right',
          color: r => statusCodeColor(r.status, theme),
          render: r => r.status === null
            ? '—'
            : String(r.status),
        },
        {
          key: 'durationMs',
          title: 'Duration',
          width: 10,
          align: 'right',
          render: r => formatMs(r.durationMs),
        },
        {
          key: 'bytes',
          title: 'Size',
          width: 10,
          align: 'right',
          render: r => formatBytes(r.bytes),
        },
        {
          key: 'address',
          title: 'Client',
          width: 18,
          color: theme.muted,
          render: r => r.address ?? '—',
        },
        { key: 'path', title: 'Path' },
      ],
    })
  })
}

const NETWORK_UNAVAILABLE = 'Not available: the game server runs with NODE_ENV=production, where nothing is recorded, '
  + 'or it runs a @mavonengine/core release without GET /api/game/dev/net'

/** Height of the packet details under the list on a narrow terminal, which leaves the list a few rows */
const NARROW_PACKET_DETAILS_SIZE = 12

/** Height of the State sync and By message panels of the Network tab */
const NETWORK_SUMMARY_SIZE = 10

/**
 * The game socket: who is sent what, what the traffic is made of, and every packet and event, newest first
 */
function networkTab(ui: Container, theme: Theme, state: DashboardState, view: ViewState, transparent: boolean) {
  if (state.packetsAvailable === false) {
    ui.panel({ title: 'Network', size: '1fr' }, panel => panel.text(NETWORK_UNAVAILABLE, { wrap: true }))
    return
  }

  ui.responsive({
    [WIDE_LAYOUT]: c => c.row({ size: NETWORK_SUMMARY_SIZE }, (row) => {
      syncPanel(row, theme, state, transparent)
      messagesPanel(row, theme, state, transparent)
    }),
    0: (c) => {
      syncPanel(c, theme, state, transparent, NETWORK_SUMMARY_SIZE)
      messagesPanel(c, theme, state, transparent, NETWORK_SUMMARY_SIZE)
    },
  })

  if (view.selectedPacketId === null) {
    packetsPanel(ui, theme, state, view, transparent)
    return
  }

  ui.responsive({
    [WIDE_LAYOUT]: c => c.row({ size: '1fr' }, (row) => {
      packetsPanel(row, theme, state, view, transparent)
      packetDetails(row, theme, state, view, '40%')
    }),
    0: (c) => {
      packetsPanel(c, theme, state, view, transparent)
      packetDetails(c, theme, state, view, NARROW_PACKET_DETAILS_SIZE)
    },
  })
}

/**
 * The content of the selected packet: its payload as it went over the wire, scrolled with the mouse wheel
 */
function packetDetails(ui: Container, theme: Theme, state: DashboardState, view: ViewState, size: number | string) {
  const id = view.selectedPacketId!
  const packet = state.packets.find(p => p.id === id)
  // The details are loaded after the selection changed, so they can still be the previous packet's
  const detail: PacketDetail | null = state.packetDetail?.id === id
    ? state.packetDetail
    : null

  const name = packet
    ? `${packet.type}${packet.direction
      ? ` ${packet.direction}`
      : ''}`
    : `#${id}`
  const title = packet?.kind === 'packet'
    ? `${name} · ${formatBytes(packet.bytes)}`
    : name

  ui.panel({ title, size }, (panel) => {
    if (packet) {
      const facts = describePacket({ ...packet, info: {} })
      panel.text([
        {
          text: formatTimeMs(packet.timestamp),
          fg: theme.muted,
        },
        ...(packet.peer
          ? [
              { text: `  ${packet.peer}` },
            ]
          : []),
        ...(facts
          ? [
              { text: `  ${facts}`, fg: theme.muted },
            ]
          : []),
      ], { size: 1 })
    }

    if (!detail || detail.status === 'loading') {
      panel.label('Loading…')
      return
    }
    if (detail.status === 'error') {
      panel.text([
        { text: detail.error ?? 'Could not load it', fg: theme.danger },
      ], { wrap: true })
      return
    }
    if (detail.status === 'gone') {
      panel.text('The server no longer keeps this payload: it keeps the last 2000 records and 8 MB of payloads.', { wrap: true })
      return
    }
    if (detail.status === 'empty') {
      panel.label('No payload')
      return
    }

    const maxOffset = Math.max(0, detail.lines.length - 1)
    view.payloadOffset = Math.min(view.payloadOffset, maxOffset)

    panel.list({
      items: detail.lines,
      offset: view.payloadOffset,
      bullet: '',
      scrollbar: true,
      size: '1fr',
      onScroll: (delta) => {
        view.payloadOffset = Math.max(0, Math.min(maxOffset, view.payloadOffset + delta * 3))
        ui.ctx.invalidate()
      },
    })
  })
}

function syncPanel(ui: Container, theme: Theme, { sync }: DashboardState, transparent: boolean, size: number | string = '1fr') {
  ui.panel({
    title: sync
      ? `State sync (tick ${sync.tick})`
      : 'State sync',
    size,
  }, (panel) => {
    if (!sync) {
      panel.label('Waiting for the server…')
      return
    }

    panel.text([
      { text: `${sync.entities}`, bold: true },
      {
        text: sync.entities === 1
          ? ' synced entity'
          : ' synced entities',
        fg: theme.muted,
      },
      ...(sync.untracked > 0
        ? [
            { text: `, ${sync.untracked} out of every player's range`, fg: theme.warning },
          ]
        : []),
      { text: '  distance ', fg: theme.muted },
      {
        text: sync.syncDistance === null
          ? 'unknown'
          : String(sync.syncDistance),
      },
      ...(sync.editors > 0
        ? [
            { text: `  ${sync.editors} editor${sync.editors === 1
              ? ''
              : 's'}`, fg: theme.info },
          ]
        : []),
    ], { size: 1 })

    if (sync.players.length === 0) {
      panel.label('No players connected')
      return
    }

    // Behind the others means its state updates are not going out
    const newest = Math.max(...sync.players.map(p => p.lastState?.tick ?? 0))

    panel.table<SyncPlayerLine>({
      rows: [...sync.players].sort((a, b) => a.id.localeCompare(b.id)),
      scrollbar: true,
      zebra: !transparent,
      size: '1fr',
      columns: [
        { key: 'displayName', title: 'Player' },
        ...(sync.players.some(p => p.account)
          ? [
              {
                key: 'account',
                title: 'Account',
                render: (p: SyncPlayerLine) => accountLabel(p.account),
              },
            ]
          : []),
        {
          key: 'tracked',
          title: 'Tracked',
          width: 8,
          align: 'right',
        },
        {
          key: 'ack',
          title: 'Ack',
          width: 9,
          align: 'right',
        },
        {
          key: 'bytes',
          title: 'State',
          width: 10,
          align: 'right',
          render: p => p.lastState
            ? formatBytes(p.lastState.bytes)
            : '—',
        },
        {
          key: 'tick',
          title: 'Tick',
          width: 9,
          align: 'right',
          color: p => !p.lastState || newest - p.lastState.tick > sync.tickRate
            ? theme.danger
            : undefined,
          render: p => p.lastState
            ? String(p.lastState.tick)
            : 'none',
        },
      ],
    })
  })
}

function messagesPanel(ui: Container, theme: Theme, state: DashboardState, transparent: boolean, size: number | string = '1fr') {
  const stats = messageStats(state.packets)

  ui.panel({ title: `By message (last ${MESSAGE_STATS_WINDOW_MS / 1000} s)`, size }, (panel) => {
    if (stats.length === 0) {
      panel.label(state.packetsAvailable === null
        ? 'Waiting for the server…'
        : 'No packets yet')
      return
    }

    panel.table<MessageStat>({
      rows: stats,
      scrollbar: true,
      zebra: !transparent,
      size: '1fr',
      columns: [
        {
          key: 'direction',
          title: '',
          width: 3,
          color: s => s.direction === 'out'
            ? theme.graph[0]
            : theme.graph[1],
          render: s => s.direction === 'out'
            ? 'out'
            : 'in',
        },
        { key: 'type', title: 'Message' },
        {
          key: 'rate',
          title: 'Per s',
          width: 8,
          align: 'right',
          render: s => s.rate.toFixed(1),
        },
        {
          key: 'avgBytes',
          title: 'Avg size',
          width: 10,
          align: 'right',
          render: s => formatBytes(Math.round(s.avgBytes)),
        },
        {
          key: 'bytesPerSecond',
          title: 'Rate',
          width: 12,
          align: 'right',
          render: s => formatRate(Math.round(s.bytesPerSecond)),
        },
      ],
    })
  })
}

function formatTimeMs(timestamp: number) {
  return `${formatTime(timestamp)}.${(timestamp % 1000).toString().padStart(3, '0')}`
}

/** The packets and events the Network table shows, oldest first */
export function visiblePackets(packets: PacketLine[], view: Pick<ViewState, 'showPings' | 'eventsOnly'>): PacketLine[] {
  return packets.filter(p =>
    (!view.eventsOnly || p.kind === 'event')
    && (view.showPings || (p.type !== 'ping' && p.type !== 'pong')))
}

function packetsPanel(ui: Container, theme: Theme, state: DashboardState, view: ViewState, transparent: boolean) {
  // Newest first, like the HTTP requests
  const rows = visiblePackets(state.packets, view).reverse()
  const anchor = view.packetTopId === null
    ? 0
    : rows.findIndex(r => r.id <= view.packetTopId!)
  const offset = Math.max(0, anchor)

  const what = view.eventsOnly ? 'Events' : 'Packets and events'
  const title = `${what} (${rows.length}${view.showPings || view.eventsOnly
    ? ''
    : ', pings hidden'})${offset > 0
    ? ', scroll up to follow'
    : ''}`

  ui.panel({ title, size: '1fr' }, (panel) => {
    if (rows.length === 0) {
      panel.label(state.packetsAvailable === null
        ? 'Waiting for the server…'
        : view.eventsOnly ? 'No events yet' : 'No packets yet')
      return
    }

    // Index of the row drawn first, which the handlers of this frame count from
    let top = offset
    // A narrow terminal, or the details panel next to the table, keeps the details and cuts the client id short
    const narrow = panel.width < WIDE_LAYOUT
    const directionColor = (p: PacketLine) => p.kind === 'event'
      ? theme.warning
      : p.direction === 'out'
        ? theme.graph[0]
        : theme.graph[1]

    panel.table<PacketLine>({
      rows,
      offset,
      scrollbar: true,
      zebra: !transparent,
      size: '1fr',
      selected: rows.findIndex(p => p.id === view.selectedPacketId),
      followSelection: view.selectedPacketId !== null && view.followSelectedPacket,
      // Following the selection can move the window, so the anchor goes by the row that was really drawn first
      onRow: (_row, index, y) => {
        if (y === 1) {
          top = index
          view.packetTopId = index === 0
            ? null
            : rows[index].id
        }
      },
      // A click opens the packet, a second one on it closes it again
      onSelectRow: (visibleRow) => {
        const row = rows[top + visibleRow]
        if (!row)
          return
        selectPacket(view, row.id === view.selectedPacketId
          ? null
          : row.id)
        ui.ctx.invalidate()
      },
      onScroll: (delta) => {
        const next = Math.max(0, Math.min(rows.length - 1, top + delta))
        view.packetTopId = next === 0
          ? null
          : rows[next].id
        view.followSelectedPacket = false
        ui.ctx.invalidate()
      },
      columns: [
        {
          key: 'time',
          title: 'Time',
          width: 12,
          color: theme.muted,
          render: p => formatTimeMs(p.timestamp),
        },
        {
          key: 'direction',
          title: '',
          width: 3,
          color: directionColor,
          render: p => p.kind === 'event'
            ? '•'
            : p.direction === 'out'
              ? 'out'
              : 'in',
        },
        {
          key: 'type',
          title: 'Message',
          width: narrow ? 12 : 18,
          color: p => p.kind === 'event'
            ? theme.warning
            : undefined,
        },
        {
          key: 'peer',
          title: 'Client',
          width: narrow ? 8 : 26,
          color: theme.muted,
          render: p => p.peer ?? '—',
        },
        {
          key: 'bytes',
          title: 'Size',
          width: narrow ? 9 : 10,
          align: 'right',
          render: p => p.kind === 'packet'
            ? formatBytes(p.bytes)
            : '',
        },
        { key: 'info', title: 'Details', render: describePacket },
      ],
    })
  })
}

function methodColor(method: string, theme: Theme): Color | undefined {
  if (method === 'GET')
    return theme.success
  if (method === 'DELETE')
    return theme.danger
  if (method === 'ALL')
    return theme.muted
  return theme.warning
}

/** Who registered a route: the engine, the game's own server, or the plugin's package */
export function routeSource(route: RouteLine): string {
  return route.source === 'plugin'
    ? route.plugin ?? 'plugin'
    : route.source
}

/** Whether a route only exists in development or is served in production too */
export function routeEnvironment(route: RouteLine): string {
  return route.devOnly ? 'dev only' : 'prod + dev'
}

function routesPanel(ui: Container, theme: Theme, state: DashboardState, view: ViewState, transparent: boolean) {
  const rows = state.routes
  const maxOffset = Math.max(0, rows.length - 1)
  const offset = Math.min(view.routeOffset ?? 0, maxOffset)
  view.routeOffset = offset

  const fromPlugins = rows.filter(r => r.source === 'plugin')
  const plugins = new Set(fromPlugins.map(routeSource)).size
  const devOnly = rows.filter(r => r.devOnly).length
  const counts = [
    `${rows.filter(r => r.source === 'engine').length} engine`,
    `${rows.filter(r => r.source === 'game').length} game`,
    `${fromPlugins.length} from ${plugins} plugin${plugins === 1
      ? ''
      : 's'}`,
    `${devOnly} dev only`,
  ]

  ui.panel({ title: `HTTP endpoints (${rows.length}: ${counts.join(', ')})`, size: '1fr' }, (panel) => {
    if (state.routesAvailable === false) {
      panel.label('Not available: the server runs a @mavonengine/core release without GET /api/game/routes')
      return
    }

    if (rows.length === 0) {
      panel.label(state.routesAvailable === null
        ? 'Asking the server for its endpoints…'
        : 'The server has no endpoints')
      return
    }

    panel.table<RouteLine>({
      rows,
      offset,
      scrollbar: true,
      // Zebra stripes are solid fills, which would break transparency
      zebra: !transparent,
      size: '1fr',
      // The table won't scroll past the last full page, so keep our offset on the row it actually drew
      onRow: (_row, index, y) => {
        if (y === 1)
          view.routeOffset = index
      },
      onScroll: (delta) => {
        view.routeOffset = Math.max(0, Math.min(maxOffset, offset + delta))
        ui.ctx.invalidate()
      },
      columns: [
        {
          key: 'method',
          title: 'Method',
          width: 7,
          color: r => methodColor(r.method, theme),
        },
        { key: 'path', title: 'Path' },
        {
          key: 'devOnly',
          title: 'Served in',
          width: 10,
          color: r => r.devOnly ? theme.warning : theme.success,
          render: routeEnvironment,
        },
        {
          key: 'source',
          title: 'From',
          width: 30,
          color: r => r.source === 'engine'
            ? theme.muted
            : r.source === 'plugin'
              ? theme.primary
              : undefined,
          render: routeSource,
        },
        {
          key: 'summary',
          title: 'What it does',
          color: theme.muted,
          render: r => r.summary ?? '',
        },
      ],
    })
  })
}

const PLUGIN_TARGETS = { client: 'client', server: 'server', both: 'client + server' }

/** One word for whether a plugin is in use, with the colour to show it in */
export function pluginStatus(plugin: PluginLine, theme: Theme): { label: string, color: Color } {
  if (plugin.problem)
    return { label: 'problem', color: theme.danger }
  if (!plugin.enabled)
    return { label: 'disabled', color: theme.muted }
  // Its server entry should run here but doesn't: it failed to load, or the server needs a restart
  if ((plugin.target === 'server' || plugin.target === 'both') && !plugin.runningOnServer)
    return { label: 'not loaded', color: theme.warning }
  return { label: 'enabled', color: theme.success }
}

function pluginsTab(ui: Container, theme: Theme, state: DashboardState, view: ViewState, transparent: boolean, available?: AvailablePlugins, installer?: DashboardInstaller) {
  const { plugins } = state

  // Only asked for once someone looks at this tab
  void available?.load()

  const rest = installable(plugins, available)
  const shown = selectedPlugin(view, plugins, rest)
  const endpoints = (plugin: PluginLine) => state.routes.filter(r => r.source === 'plugin' && r.plugin === plugin.package)
  // Something on the list may have been installed since it was asked about
  const confirm = rest.find(p => p.package === view.confirmInstall)
  if (!confirm)
    view.confirmInstall = null

  if (state.pluginsAvailable === false || plugins.length === 0) {
    ui.panel({
      title: 'Plugins',
      size: available ? 3 : '1fr',
    }, (panel) => {
      if (state.pluginsAvailable === false) {
        panel.label('Not available: the server runs a @mavonengine/core release without GET /api/game/plugins')
      }
      else {
        panel.label(state.pluginsAvailable === null
          ? 'Asking the server for its plugins…'
          : 'The project has no plugins. Add one with: mavonengine install <package>')
      }
    })
  }
  else {
    let top = 0

    // The list on top at its full width, so the package names and every column fit whatever the terminal's width
    ui.panel({ title: `Plugins (${plugins.length})`, size: Math.min(plugins.length, 8) + 3 }, (panel) => {
      panel.table<PluginLine>({
        rows: plugins,
        selected: shown.installed
          ? plugins.indexOf(shown.installed)
          : -1,
        followSelection: true,
        // With more plugins than rows the table scrolls to the selection, so a click counts from the row drawn first
        onRow: (_row, index, y) => {
          if (y === 1)
            top = index
        },
        onSelectRow: (visibleRow) => {
          const row = plugins[top + visibleRow]
          if (!row || view.confirmInstall)
            return
          view.selectedPlugin = row.package
          ui.ctx.invalidate()
        },
        scrollbar: true,
        // Zebra stripes are solid fills, which would break transparency
        zebra: !transparent,
        size: '1fr',
        columns: [
          { key: 'package', title: 'Package' },
          {
            key: 'version',
            title: 'Version',
            width: 8,
            render: p => p.version ?? '—',
          },
          {
            key: 'status',
            title: 'Status',
            width: 10,
            color: p => pluginStatus(p, theme).color,
            render: p => pluginStatus(p, theme).label,
          },
          {
            key: 'target',
            title: 'Runs on',
            width: 7,
            render: p => p.target ?? '—',
          },
          {
            key: 'endpoints',
            title: 'Routes',
            width: 6,
            align: 'right',
            render: p => state.routesAvailable
              ? String(endpoints(p).length)
              : '—',
          },
          {
            key: 'prefabs',
            title: 'Prefabs',
            width: 7,
            align: 'right',
            render: p => String(new Set([
              ...p.declaredPrefabs,
              ...p.usedPrefabs,
            ]).size),
          },
        ],
      })
    })
  }

  if (installer?.job)
    installPanel(ui, theme, installer.job)

  if (confirm)
    confirmInstallPanel(ui, theme, confirm)
  else if (shown.installed)
    pluginDetails(ui, theme, state, shown.installed, endpoints(shown.installed), '1fr', transparent)
  else if (shown.available)
    availableDetails(ui, theme, shown.available, installer)

  if (available) {
    availablePanel(ui, theme, available, rest, shown.available, view, shown.installed || confirm || shown.available
      ? Math.min(Math.max(1, rest.length), 6) + 3
      : '1fr', transparent)
  }
}

/** Lines of an install's output kept on screen */
const INSTALL_OUTPUT_LINES = 6

const INSTALL_STATUS: Record<InstallJob['status'], string> = {
  installing: 'Installing',
  restarting: 'Installed, restarting the dev servers for',
  done: 'Installed',
  failed: 'Could not install',
}

function installPanel(ui: Container, theme: Theme, job: InstallJob) {
  const lines = stripVTControlCharacters(job.output).split(NEWLINE_RE).filter(line => line.trim() !== '')
  const color = job.status === 'failed'
    ? theme.danger
    : job.status === 'done'
      ? theme.success
      : theme.warning

  ui.panel({ title: `${INSTALL_STATUS[job.status]} ${job.packages.join(', ')}`, size: INSTALL_OUTPUT_LINES + 3 }, (panel) => {
    if (job.status === 'failed') {
      panel.text([
        { text: job.error ?? 'The install failed', fg: color },
      ], { size: 1 })
    }
    else if (job.status === 'done') {
      panel.text([
        { text: 'The dev servers were restarted with it', fg: color },
      ], { size: 1 })
    }
    else {
      panel.spinner({
        label: job.status === 'restarting'
          ? 'Stopping and starting the dev script'
          : 'Running the package manager',
        size: 1,
      })
    }

    panel.log({
      entries: lines.slice(-INSTALL_OUTPUT_LINES).map(message => ({ message })),
      size: '1fr',
    })
  })
}

/**
 * Asked before anything is installed: a package runs its own code on this machine, when it is installed and
 * every time the game runs, so whoever installs it should have looked at where it comes from.
 */
function confirmInstallPanel(ui: Container, theme: Theme, plugin: AvailablePlugin) {
  ui.panel({ title: `Install ${plugin.package}?`, size: '1fr' }, (panel) => {
    panel.text([
      { text: 'Installing a package runs its code on this machine.', fg: theme.warning, bold: true },
    ], { wrap: true })
    panel.text('Its install scripts run right away, and the plugin runs inside your game and game server from then on, with everything they can reach. The list of plugins is not a review of what is on it.', { wrap: true })
    panel.spacer(1)
    panel.text('Check the source before you install it:', { wrap: true })
    panel.text([
      { text: `  ${plugin.homepage ?? `https://www.npmjs.com/package/${plugin.package}`}`, fg: theme.primary },
    ], { wrap: true })
    panel.spacer(1)
    panel.text(`It is installed with the project's package manager, added to mavonengine.json, and the dev servers are restarted.`, { wrap: true })
    panel.spacer(1)
    panel.text([
      {
        text: ' y ',
        fg: theme.background,
        bg: theme.warning,
        bold: true,
      },
      { text: ' I checked the source, install it    ' },
      {
        text: ' n ',
        fg: theme.background,
        bg: theme.muted,
        bold: true,
      },
      { text: ' Cancel' },
    ], { size: 1 })
  })
}

function availableDetails(ui: Container, theme: Theme, plugin: AvailablePlugin, installer?: DashboardInstaller) {
  ui.panel({
    title: plugin.name === plugin.package
      ? plugin.package
      : `${plugin.name} (${plugin.package})`,
    size: '1fr',
  }, (panel) => {
    if (plugin.description)
      panel.text(plugin.description, { wrap: true })

    panel.keyValues([
      { label: 'Status', value: 'not installed', color: theme.muted },
      {
        label: 'Runs on',
        value: plugin.target ? PLUGIN_TARGETS[plugin.target] : '—',
      },
      {
        label: 'Engine',
        value: plugin.engine
          ? `@mavonengine/core ${plugin.engine}`
          : '—',
      },
      { label: 'Source', value: plugin.homepage ?? `https://www.npmjs.com/package/${plugin.package}`, color: theme.primary },
    ], { spread: true })

    panel.spacer(1)

    if (!installer) {
      panel.label(`Install it with: mavonengine install ${plugin.package}`)
    }
    else if (installer.busy) {
      panel.label('Another install is running')
    }
    else {
      panel.text([
        { text: 'Press ' },
        { text: 'i', fg: theme.primary, bold: true },
        { text: ' to install it and restart the dev servers' },
      ], { size: 1 })
    }
  })
}

/**
 * The plugins of the public list that the project doesn't have yet
 */
function availablePanel(ui: Container, theme: Theme, available: AvailablePlugins, rows: AvailablePlugin[], selected: AvailablePlugin | undefined, view: ViewState, size: number | string, transparent: boolean) {
  const { status, error, plugins } = available.state
  const loaded = status === 'ready' || plugins.length > 0
  let top = 0

  ui.panel({
    title: loaded
      ? `Available to install (${rows.length})`
      : 'Available to install',
    size,
  }, (panel) => {
    if (error) {
      panel.text([
        { text: `Could not read the list of plugins: ${error}`, fg: theme.danger },
      ], { wrap: true })
      return
    }

    if (!loaded) {
      panel.spinner({ label: 'Reading the list of plugins from GitHub' })
      return
    }

    if (rows.length === 0) {
      panel.label(plugins.length ? 'The project has every plugin on the list' : 'The list of plugins is empty')
      return
    }

    panel.table<AvailablePlugin>({
      rows,
      selected: selected
        ? rows.indexOf(selected)
        : -1,
      followSelection: true,
      onRow: (_row, index, y) => {
        if (y === 1)
          top = index
      },
      onSelectRow: (visibleRow) => {
        const row = rows[top + visibleRow]
        if (!row || view.confirmInstall)
          return
        view.selectedPlugin = row.package
        ui.ctx.invalidate()
      },
      scrollbar: true,
      zebra: !transparent,
      size: '1fr',
      columns: [
        { key: 'package', title: 'Package', color: theme.primary },
        {
          key: 'target',
          title: 'Runs on',
          width: 7,
          render: p => p.target ?? '—',
        },
        {
          key: 'description',
          title: 'What it is',
          color: theme.muted,
          render: p => p.description ?? (p.name === p.package
            ? ''
            : p.name),
        },
      ],
    })
  })
}

function pluginDetails(ui: Container, theme: Theme, state: DashboardState, plugin: PluginLine, endpoints: RouteLine[], size: number | string, transparent: boolean) {
  const status = pluginStatus(plugin, theme)
  const prefabs = [
    ...new Set([
      ...plugin.declaredPrefabs,
      ...plugin.usedPrefabs,
    ]),
  ]

  ui.panel({ title: plugin.package, size }, (panel) => {
    if (plugin.description)
      panel.text(plugin.description, { wrap: true })
    if (plugin.problem) {
      panel.text([
        { text: plugin.problem, fg: theme.danger },
      ], { wrap: true })
    }

    panel.keyValues([
      { label: 'Version', value: plugin.version ?? '—' },
      { label: 'Status', value: status.label, color: status.color },
      {
        label: 'Runs on',
        value: plugin.target ? PLUGIN_TARGETS[plugin.target] : '—',
      },
      // A client plugin has nothing to run here
      plugin.target === 'client'
        ? { label: 'On this server', value: 'nothing to run', color: theme.muted }
        : {
            label: 'On this server',
            value: plugin.runningOnServer ? 'running' : 'not running',
            color: plugin.runningOnServer ? theme.success : theme.warning,
          },
      {
        label: 'Engine',
        value: plugin.engine
          ? `@mavonengine/core ${plugin.engine}`
          : '—',
      },
      { label: 'License', value: plugin.license ?? '—' },
      // Used ones ship their assets in a release
      {
        label: 'Prefabs',
        value: prefabs.length
          ? prefabs.map(name => plugin.usedPrefabs.includes(name)
              ? `${name} (used)`
              : name).join(', ')
          : 'none',
      },
    ], { spread: true })

    panel.spacer(1)

    if (state.routesAvailable !== true) {
      panel.label('HTTP endpoints: unknown, the server doesn\'t list its endpoints')
      return
    }
    if (endpoints.length === 0) {
      panel.label('HTTP endpoints: none')
      return
    }

    panel.label(`HTTP endpoints (${endpoints.length})`)
    panel.table<RouteLine>({
      rows: endpoints,
      scrollbar: true,
      zebra: !transparent,
      size: '1fr',
      columns: [
        {
          key: 'method',
          title: 'Method',
          width: 7,
          color: r => methodColor(r.method, theme),
        },
        { key: 'path', title: 'Path' },
        {
          key: 'devOnly',
          title: 'Served in',
          width: 10,
          color: r => r.devOnly ? theme.warning : theme.success,
          render: routeEnvironment,
        },
      ],
    })
  })
}

const MAX_CELL_CHARS = 60
const LINE_BREAKS_RE = /\r?\n/g

/** One value of a database row as a table cell */
export function formatCell(value: unknown): string {
  let text: string
  if (value === null || value === undefined)
    text = 'NULL'
  else if (typeof value === 'object')
    text = JSON.stringify(value)
  else
    text = String(value).replace(LINE_BREAKS_RE, ' ⏎ ')

  return text.length > MAX_CELL_CHARS
    ? `${text.slice(0, MAX_CELL_CHARS - 1)}…`
    : text
}

function tableOwner(table: { plugin: string | null }): string {
  return table.plugin ?? 'game'
}

function databaseTab(ui: Container, theme: Theme, state: DashboardState, view: ViewState, transparent: boolean) {
  const { database } = state

  const notice = state.databaseAvailable === false
    ? 'Not available: the server runs a @mavonengine/core release without GET /api/game/database'
    : !database
        ? state.databaseError ?? 'Asking the server for its database…'
        : !database.provider
            ? 'The project has no database plugin. Add one with: mavonengine install @mavonengine/sqlite'
            : database.tables.length === 0
              ? `No tables yet in the database of ${database.provider}`
              : null

  if (notice) {
    ui.panel({ title: 'Database', size: '1fr' }, (panel) => {
      panel.text([
        {
          text: notice,
          fg: state.databaseError && !database
            ? theme.danger
            : theme.muted,
        },
      ])
    })
    return
  }

  const { tables, migrations } = database!
  const shown = selectedTable(view, database)!
  let top = 0

  if (state.databaseError) {
    ui.text([
      { text: ` ${state.databaseError} — showing what was read last`, fg: theme.danger },
    ], { size: 1 })
  }

  ui.panel({ title: `Tables in ${database!.provider} (${tables.length})`, size: Math.min(tables.length, 8) + 3 }, (panel) => {
    panel.table<DatabaseTableLine>({
      rows: tables,
      selected: tables.indexOf(shown),
      followSelection: true,
      onRow: (_row, index, y) => {
        if (y === 1)
          top = index
      },
      onSelectRow: (visibleRow) => {
        const row = tables[top + visibleRow]
        if (!row)
          return
        view.selectedTable = row.name
        view.tableOffset = 0
        ui.ctx.invalidate()
      },
      scrollbar: true,
      // Zebra stripes are solid fills, which would break transparency
      zebra: !transparent,
      size: '1fr',
      columns: [
        { key: 'name', title: 'Table' },
        {
          key: 'plugin',
          title: 'Plugin',
          color: t => t.plugin ? theme.primary : theme.muted,
          render: tableOwner,
        },
        {
          key: 'rows',
          title: 'Rows',
          width: 10,
          align: 'right',
          render: t => t.rows === null
            ? '?'
            : t.rows.toLocaleString('en-US'),
        },
        {
          key: 'columns',
          title: 'Columns',
          width: 7,
          align: 'right',
          render: t => String(t.columns.length),
        },
      ],
    })
  })

  tableRowsPanel(ui, theme, state, view, shown, transparent)

  if (migrations.length) {
    ui.panel({ title: 'Migrations', size: Math.min(migrations.length, 4) + 2 }, (panel) => {
      for (const m of migrations.slice(0, 4)) {
        const names = m.applied.map(a => a.name).join(', ') || 'none'
        panel.text([
          {
            text: `${m.plugin ?? m.table}  `,
            fg: m.plugin ? theme.primary : theme.muted,
          },
          { text: `${m.applied.length} ran: `, fg: theme.muted },
          { text: names },
        ])
      }
    })
  }
}

function tableRowsPanel(ui: Container, theme: Theme, state: DashboardState, view: ViewState, table: DatabaseTableLine, transparent: boolean) {
  const detail = state.tableDetail?.table === table.name
    ? state.tableDetail
    : null
  const page = detail?.page
  const total = page?.total ?? table.rows ?? 0
  const shownRows = page
    ? Math.min(page.rows.length, view.tableVisibleRows || page.rows.length)
    : 0
  const range = page && shownRows
    ? `rows ${(page.offset + 1).toLocaleString('en-US')}–${(page.offset + shownRows).toLocaleString('en-US')} of ${total.toLocaleString('en-US')}`
    : `${total.toLocaleString('en-US')} rows`

  ui.panel({ title: `${table.name} · ${range}${detail?.status === 'loading'
    ? ' · loading…'
    : ''}`, size: '1fr' }, (panel) => {
    if (detail?.status === 'error') {
      panel.text([
        { text: detail.error ?? 'Could not load the rows', fg: theme.danger },
      ], { size: 1 })
    }

    if (!page) {
      if (detail?.status !== 'error')
        panel.label('Loading the rows…')
      return
    }

    if (page.rows.length === 0) {
      panel.label('The table is empty')
      return
    }

    const columns = page.columns.length
      ? page.columns.map(c => c.name)
      : Object.keys(page.rows[0])
    let visible = 0
    panel.table<Record<string, unknown>>({
      rows: page.rows,
      // Counts the rows that fit, so paging moves by a screenful
      onRow: (_row, _index, y) => {
        visible = Math.max(visible, y)
        view.tableVisibleRows = visible
      },
      scrollbar: true,
      zebra: !transparent,
      size: '1fr',
      columns: columns.map(name => ({
        key: name,
        title: name,
        color: (row: Record<string, unknown>) => row[name] === null || row[name] === undefined
          ? theme.muted
          : undefined,
        render: (row: Record<string, unknown>) => formatCell(row[name]),
      })),
    })
  })
}
