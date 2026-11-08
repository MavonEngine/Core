// The game server dashboard in the browser: the same tabs and data as `mavonengine dashboard`.
// Plain browser JavaScript, served as is. Everything from the server goes into the page as text,
// never as HTML: player names, log lines and request paths are not trusted.

import {
  appendFeed,
  backoff,
  formatBytes,
  formatDuration,
  formatMs,
  formatPercent,
  formatRate,
  formatTime,
  showNames,
  sortedPlayers,
  statusClass,
  trimMessage,
} from './format.js'

const TABS = ['overview', 'players', 'logs', 'http']
const POLL_MS = Number(document.body.dataset.pollInterval) || 1000
const SVG_NS = 'http://www.w3.org/2000/svg'
/** Rows of the overview's log panel */
const OVERVIEW_LOG_LINES = 200
const LAST_SEGMENT_RE = /\/[^/]*$/

const state = {
  status: 'connecting',
  error: null,
  failures: 0,
  snapshot: null,
  lastUpdate: null,
  logs: [],
  logsAfter: 0,
  logsAvailable: null,
  requests: [],
  requestsAfter: 0,
  requestsAvailable: null,
  selectedPlayerId: null,
}

let pollTimer = null
let polling = false

// ---------------------------------------------------------------- DOM helpers

const $ = id => document.getElementById(id)

/** An element with text content and attributes. Children are elements or strings (as text) */
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false)
      continue
    if (key === 'class')
      node.className = value
    else if (key === 'style')
      setStyle(node, value)
    else if (key.startsWith('on'))
      node.addEventListener(key.slice(2), value)
    else
      node.setAttribute(key, value === true ? '' : String(value))
  }
  for (const child of children.flat()) {
    if (child !== undefined && child !== null && child !== false)
      node.append(child instanceof Node ? child : String(child))
  }
  return node
}

/** Inline styles, including custom properties (which Object.assign on `style` would drop) */
function setStyle(node, styles) {
  for (const [property, value] of Object.entries(styles)) {
    if (property.startsWith('--'))
      node.style.setProperty(property, value)
    else
      node.style[property] = value
  }
}

/** An SVG element. `style` takes colors like `var(--graph-0)`, which presentation attributes don't resolve */
function svg(tag, attrs = {}) {
  const node = document.createElementNS(SVG_NS, tag)
  for (const [key, value] of Object.entries(attrs)) {
    if (key === 'style')
      setStyle(node, value)
    else
      node.setAttribute(key, String(value))
  }
  return node
}

function values(container, entries) {
  container.replaceChildren(...entries.flatMap(({ label, value, cls }) => [
    el('dt', {}, label),
    el('dd', { class: cls }, value),
  ]))
}

function meter(label, value, max, text) {
  const ratio = max > 0 ? Math.min(1, Math.max(0, value / max)) : 0
  const level = ratio >= 0.9 ? 'danger' : ratio >= 0.7 ? 'warning' : ''
  return el('div', { class: 'meter' }, el('span', { class: 'muted' }, label), el('div', { class: 'meter-bar' }, el('div', { class: `meter-fill ${level}`, style: { width: `${ratio * 100}%` } })), el('span', {}, text))
}

function legend(container, series) {
  container.replaceChildren(...series.map(s => el('span', { style: { '--swatch': s.color } }, s.label)))
}

/**
 * A line chart of `series` ({ values, color, fill? }) between min and max, with an optional budget line.
 */
function chart(container, series, { min = 0, max, format, budget, heat = false }) {
  const length = Math.max(2, ...series.map(s => s.values.length))
  const highest = Math.max(max ?? 0, ...series.flatMap(s => s.values))
  // Nothing measured yet: a scale of 1 rather than a sliver above 0
  const top = highest > min ? highest : min + 1
  const width = 100
  const height = 100
  const x = i => (i / (length - 1)) * width
  const y = v => height - ((v - min) / (top - min)) * height

  const root = svg('svg', { viewBox: `0 0 ${width} ${height}`, preserveAspectRatio: 'none' })
  for (const fraction of [0, 0.5, 1])
    root.append(svg('line', { class: 'grid-line', x1: 0, x2: width, y1: height * fraction, y2: height * fraction }))

  if (heat) {
    // Greener at the bottom of the scale, redder at the top, like the CLI's CPU graph
    const id = `heat-${container.id}`
    const gradient = svg('linearGradient', { id, x1: 0, x2: 0, y1: 1, y2: 0 })
    for (let i = 0; i < 5; i++)
      gradient.append(svg('stop', { offset: `${i * 25}%`, style: { stopColor: `var(--heat-${i})` } }))
    const defs = svg('defs')
    defs.append(gradient)
    root.append(defs)
  }

  if (budget !== undefined && budget > 0)
    root.append(svg('line', { class: 'budget', x1: 0, x2: width, y1: y(budget), y2: y(budget) }))

  for (const s of series) {
    // Right-aligned, so a short history grows in from the right like the CLI
    const offset = length - s.values.length
    const points = s.values.map((v, i) => `${x(i + offset).toFixed(2)},${y(v).toFixed(2)}`)
    if (points.length === 0)
      continue

    if (s.fill) {
      root.append(svg('polygon', {
        points: `${x(offset).toFixed(2)},${height} ${points.join(' ')} ${x(length - 1).toFixed(2)},${height}`,
        style: { fill: heat ? `url(#heat-${container.id})` : s.color, fillOpacity: heat ? 0.35 : 0.15 },
      }))
    }
    root.append(svg('polyline', { points: points.join(' '), style: { stroke: heat ? `url(#heat-${container.id})` : s.color } }))
  }

  container.replaceChildren(
    el('span', { class: 'axis top' }, format(top)),
    el('span', { class: 'axis bottom' }, format(min)),
    root,
  )
}

function table(columns, rows, { rowAttrs } = {}) {
  return el('table', {}, el('thead', {}, el('tr', {}, columns.map(c => el('th', { class: c.num ? 'num' : undefined }, c.title)))), el('tbody', {}, rows.map(row => el('tr', rowAttrs?.(row) ?? {}, columns.map(c => el('td', { class: [c.num ? 'num' : '', c.cls?.(row) ?? ''].join(' ').trim() || undefined }, c.render(row)))))))
}

// ---------------------------------------------------------------- Data

/**
 * Absolute URL of a path next to the page. Built from location.origin, which never holds credentials:
 * with the page opened as http://user:pass@host/…, fetching a relative URL would throw.
 */
function apiUrl(path) {
  return `${location.origin}${location.pathname.replace(LAST_SEGMENT_RE, '/')}${path}`
}

async function getJson(path) {
  const res = await fetch(apiUrl(path), { cache: 'no-store', credentials: 'same-origin' })
  if (res.status === 401)
    throw Object.assign(new Error('Your login was not accepted. Reload the page to log in again.'), { status: 'unauthorized' })
  if (res.status === 403)
    throw Object.assign(new Error('Monitoring is only available from the server\'s own machine until a login is configured.'), { status: 'forbidden' })
  if (res.status === 429)
    throw Object.assign(new Error('Too many failed logins from this address, try again in a few minutes.'), { status: 'forbidden' })
  if (res.status === 404)
    return null
  if (!res.ok)
    throw Object.assign(new Error(`The server answered ${res.status} ${res.statusText}`), { status: 'unreachable' })
  return res.json()
}

/** Fetch what a feed has after its last id. Resolves with the new entries, or null when the server doesn't have the feed */
async function pollFeed(name) {
  const after = state[`${name}After`]
  const page = await getJson(`api/${name}?after=${after}`)
  if (page === null) {
    state[`${name}Available`] = false
    return []
  }

  state[`${name}Available`] = true
  // The server restarted: its ids start over
  if (page.latestId < after) {
    state[name] = []
    state[`${name}After`] = 0
    return pollFeed(name)
  }

  const added = page.entries.filter(e => e.id > after)
  state[name] = appendFeed(state[name], added)
  state[`${name}After`] = page.latestId
  return added
}

async function poll() {
  // `r` while a poll is under way would run two at once and double the feeds
  if (polling)
    return
  polling = true
  clearTimeout(pollTimer)
  try {
    const [snapshot, logs, requests] = await Promise.all([
      getJson('api/metrics'),
      state.logsAvailable === false ? [] : pollFeed('logs'),
      state.requestsAvailable === false ? [] : pollFeed('requests'),
    ])
    if (!snapshot)
      throw Object.assign(new Error('The metrics endpoint was not found'), { status: 'unreachable' })

    state.snapshot = snapshot
    state.status = 'live'
    state.failures = 0
    state.lastUpdate = Date.now()
    state.error = null
    render({ newLogs: logs, newRequests: requests })
  }
  catch (err) {
    state.failures++
    state.status = err.status ?? 'unreachable'
    state.error = err.status ? err.message : `Can't reach the game server: ${err.message}`
    renderStatus()
  }
  finally {
    polling = false
  }

  // A rejected login won't fix itself by asking again
  if (state.status !== 'unauthorized')
    pollTimer = setTimeout(poll, backoff(POLL_MS, state.failures))
}

// ---------------------------------------------------------------- Rendering

function currentTab() {
  const tab = location.hash.slice(1)
  return TABS.includes(tab) ? tab : 'overview'
}

function renderTabs() {
  const active = currentTab()
  for (const tab of TABS) {
    $(`tab-${tab}`).hidden = tab !== active
    const link = document.querySelector(`[data-tab="${tab}"]`)
    if (tab === active)
      link.setAttribute('aria-current', 'page')
    else
      link.removeAttribute('aria-current')
  }
  $('footer-players').hidden = active !== 'players'
}

function renderStatus() {
  const status = $('status')
  status.className = `status ${state.status}`
  status.textContent = { live: 'LIVE', connecting: 'CONNECTING', unreachable: 'UNREACHABLE', unauthorized: 'UNAUTHORIZED', forbidden: 'FORBIDDEN' }[state.status] ?? state.status.toUpperCase()

  const notice = $('notice')
  notice.hidden = !state.error
  notice.textContent = state.error
    ? `${state.error}${state.status === 'unreachable' ? ` Retrying (attempt ${state.failures})…` : ''}`
    : ''

  $('updated').textContent = state.lastUpdate ? `updated ${formatTime(state.lastUpdate)}` : ''
}

function renderHeader(snapshot) {
  $('source').textContent = location.host
  $('uptime').textContent = formatDuration(snapshot.uptime)
  $('engine').textContent = snapshot.engineVersion

  const latency = snapshot.latencySimulation
  const banner = $('latency')
  banner.hidden = !latency
  if (latency)
    banner.textContent = `LATENCY SIMULATION ON  ${latency.fixedLatency}ms ± ${latency.jitter / 2}ms, ${formatPercent(latency.packetLoss * 100)} packet loss`
}

function renderOverview(snapshot) {
  const { cpu, bandwidth, tick, tickRate, sampleIntervalMs, players, world, physics, memory } = snapshot

  // CPU
  const cpuValues = cpu.history.map(h => h.cpuPercentage)
  chart($('cpu-chart'), [{ values: cpuValues, color: 'var(--heat-0)', fill: true }], { max: Math.max(100, ...cpuValues), format: v => `${Math.round(v)}%`, heat: true })
  $('cpu-meters').replaceChildren(
    meter('1s', cpu.avg1s, 100, formatPercent(cpu.avg1s)),
    meter('10s', cpu.avg10s, 100, formatPercent(cpu.avg10s)),
    meter('1m', cpu.avg60s, 100, formatPercent(cpu.avg60s)),
  )

  // Network
  const perSecond = 1000 / (sampleIntervalMs || 1000)
  const net = [
    { label: 'sent', values: bandwidth.history.map(b => b.sent * perSecond), color: 'var(--graph-0)' },
    { label: 'received', values: bandwidth.history.map(b => b.received * perSecond), color: 'var(--graph-1)' },
  ]
  legend($('net-legend'), net)
  chart($('net-chart'), net, { format: formatRate })
  values($('net-values'), [
    { label: 'Sent', value: formatRate(bandwidth.sentPerSecond), cls: 'primary' },
    { label: 'Received', value: formatRate(bandwidth.receivedPerSecond), cls: 'success' },
  ])

  // Tick
  const latest = tick.latest
  const max = tick.history.map(t => t.maxMs)
  const tickSeries = [
    { label: 'avg', values: tick.history.map(t => t.avgMs), color: 'var(--graph-0)' },
    { label: 'max', values: max, color: 'var(--graph-2)' },
  ]
  legend($('tick-legend'), [...tickSeries, { label: 'budget', color: 'var(--warning)' }])
  chart($('tick-chart'), tickSeries, { max: Math.max(tick.budgetMs * 1.25, ...max, 1), format: v => `${v.toFixed(0)}ms`, budget: tick.budgetMs })
  $('tick-meter').replaceChildren(meter('Budget', latest?.avgMs ?? 0, tick.budgetMs || 1, `${formatMs(latest?.avgMs ?? 0)} / ${formatMs(tick.budgetMs)}`))
  const ticksPerSecond = latest?.ticksPerSecond ?? 0
  values($('tick-values'), [
    { label: 'Ticks/s', value: `${ticksPerSecond} / ${tickRate}`, cls: ticksPerSecond < tickRate * 0.9 ? 'danger' : undefined },
    { label: 'Commands/s', value: `${latest?.commandsPerSecond ?? 0} (max ${latest?.maxCommandsPerTick ?? 0}/tick)` },
  ])

  // World
  values($('world-values'), [
    { label: 'Players', value: String(players.length), cls: 'primary' },
    { label: 'Entities', value: String(world.entities) },
    { label: 'Physics bodies', value: physics ? String(physics.bodies) : '—' },
    { label: 'Colliders', value: physics ? String(physics.colliders) : '—' },
    { label: 'RSS', value: formatBytes(memory.rss) },
    { label: 'External', value: formatBytes(memory.external) },
  ])
  $('heap-meter').replaceChildren(meter('Heap', memory.heapUsed, memory.heapTotal || 1, `${formatBytes(memory.heapUsed)} / ${formatBytes(memory.heapTotal)}`))

  $('overview-players-title').textContent = `Players (${players.length})`
  $('overview-players').replaceChildren(playersTable(players, false))
}

function playersTable(players, selectable) {
  const rows = sortedPlayers(players)
  if (rows.length === 0)
    return el('p', { class: 'empty' }, 'No players connected')

  const columns = [
    ...(showNames(rows) ? [{ title: 'Name', render: p => p.displayName }] : []),
    { title: 'ID', render: p => p.id },
    { title: 'X', num: true, render: p => p.position.x.toFixed(2) },
    { title: 'Y', num: true, render: p => p.position.y.toFixed(2) },
    { title: 'Z', num: true, render: p => p.position.z.toFixed(2) },
    { title: 'Seq', num: true, render: p => String(p.lastProcessedSequenceId) },
    { title: 'Tracked', num: true, render: p => String(p.trackedEntities) },
  ]

  return table(columns, rows, {
    rowAttrs: selectable
      ? p => ({
        'class': `selectable${p.id === state.selectedPlayerId ? ' selected' : ''}`,
        'data-player': p.id,
        'onclick': () => selectPlayer(p.id === state.selectedPlayerId ? null : p.id),
      })
      : undefined,
  })
}

function renderPlayers(snapshot) {
  const { players } = snapshot
  const selected = players.find(p => p.id === state.selectedPlayerId)
  // Nothing picked yet, or the player disconnected
  if (!selected)
    state.selectedPlayerId = null

  $('players-title').textContent = `Players (${players.length})`
  $('players').replaceChildren(playersTable(players, true))

  const details = $('player-details')
  details.hidden = !selected
  if (!selected)
    return

  const { connection, position } = selected
  $('player-details-title').textContent = selected.displayName
  values($('player-details-values'), [
    { label: 'ID', value: selected.id },
    { label: 'Connected', value: formatDuration(selected.connectedFor) },
    { label: 'IP', value: connection ? connection.address ?? 'pending' : '—', cls: 'primary' },
    { label: 'RTT', value: connection?.rttMs != null ? formatMs(connection.rttMs) : '—' },
    { label: 'Sent', value: connection ? formatBytes(connection.bytesSent) : '—' },
    { label: 'Received', value: connection ? formatBytes(connection.bytesReceived) : '—' },
    { label: 'Position', value: [position.x, position.y, position.z].map(n => n.toFixed(2)).join(', ') },
    { label: 'Last seq', value: String(selected.lastProcessedSequenceId) },
    { label: 'Tracked', value: String(selected.trackedEntities) },
  ])
  $('player-details-note').hidden = !!connection
}

function selectPlayer(id) {
  state.selectedPlayerId = id
  if (state.snapshot)
    renderPlayers(state.snapshot)
}

const LEVEL_CLASSES = { error: 'danger', warn: 'warning', info: 'primary', http: 'info', verbose: 'muted', debug: 'muted', silly: 'muted' }

function logLine(entry) {
  return el('div', { class: 'log-line' }, el('span', { class: 'muted' }, formatTime(entry.timestamp)), el('span', { class: LEVEL_CLASSES[entry.level.toLowerCase()] ?? '' }, entry.level.toUpperCase()), el('span', { class: 'log-message' }, trimMessage(entry.message)))
}

/** Whether a scrolled list is at its end, so new entries should keep it there */
function atBottom(node) {
  return node.scrollHeight - node.scrollTop - node.clientHeight < 8
}

function renderLogs(container, entries, { added, limit, unavailable }) {
  if (unavailable) {
    container.replaceChildren(el('p', { class: 'empty' }, 'Not available: the server keeps no logs (metrics.logBufferSize is 0)'))
    return
  }
  if (entries.length === 0) {
    container.replaceChildren(el('p', { class: 'empty' }, 'No log output yet'))
    return
  }

  const follow = atBottom(container)
  // Append what's new rather than rebuilding, so a scrolled-back view stays put
  if (added === null || container.querySelector('.empty'))
    container.replaceChildren(...entries.slice(-limit).map(logLine))
  else
    container.append(...added.map(logLine))

  while (container.childElementCount > limit)
    container.firstElementChild.remove()

  if (follow)
    container.scrollTop = container.scrollHeight
}

function renderRequests(added) {
  const container = $('requests')
  const rows = state.requests
  const errors = rows.filter(r => r.status === null || r.status >= 400).length
  $('requests-title').textContent = `HTTP requests (${rows.length}${errors ? `, ${errors} error${errors === 1 ? '' : 's'}` : ''})`

  if (state.requestsAvailable === false) {
    container.replaceChildren(el('p', { class: 'empty' }, 'Not available: the server records no requests (metrics.requestLogSize is 0)'))
    return
  }
  if (rows.length === 0) {
    container.replaceChildren(el('p', { class: 'empty' }, 'No requests yet'))
    return
  }
  if (added !== null && added.length === 0 && container.querySelector('table'))
    return

  // Newest first. Keep a scrolled-down view on the same rows as new ones arrive at the top
  const scrolledFromTop = container.scrollTop
  const heightBefore = container.scrollHeight
  container.replaceChildren(table([
    { title: 'Time', cls: () => 'muted', render: r => formatTime(r.timestamp) },
    { title: 'Method', cls: r => (r.method === 'WS' ? 'primary' : ''), render: r => r.method },
    { title: 'Status', num: true, cls: r => statusClass(r.status), render: r => (r.status === null ? '—' : String(r.status)) },
    { title: 'Duration', num: true, render: r => formatMs(r.durationMs) },
    { title: 'Size', num: true, render: r => formatBytes(r.bytes) },
    { title: 'Client', cls: () => 'muted', render: r => r.address ?? '—' },
    { title: 'Path', cls: () => 'path', render: r => r.path },
  ], [...rows].reverse()))
  if (scrolledFromTop > 0)
    container.scrollTop = scrolledFromTop + (container.scrollHeight - heightBefore)
}

/**
 * `newLogs` / `newRequests` are what arrived with this poll, or null to redraw everything.
 */
function render({ newLogs = null, newRequests = null } = {}) {
  renderStatus()
  renderTabs()
  const { snapshot } = state
  if (!snapshot)
    return

  renderHeader(snapshot)
  const tab = currentTab()
  if (tab === 'overview') {
    renderOverview(snapshot)
    renderLogs($('overview-logs'), state.logs, { added: newLogs, limit: OVERVIEW_LOG_LINES, unavailable: state.logsAvailable === false })
  }
  else if (tab === 'players') {
    renderPlayers(snapshot)
  }
  else if (tab === 'logs') {
    $('logs-title').textContent = `Logs (${state.logs.length})`
    renderLogs($('logs'), state.logs, { added: newLogs, limit: Infinity, unavailable: state.logsAvailable === false })
  }
  else if (tab === 'http') {
    renderRequests(newRequests)
  }
}

// ---------------------------------------------------------------- Input

window.addEventListener('hashchange', () => render())

document.addEventListener('keydown', (event) => {
  if (event.ctrlKey || event.metaKey || event.altKey || event.target instanceof HTMLInputElement)
    return

  const index = Number(event.key) - 1
  if (Number.isInteger(index) && index >= 0 && index < TABS.length) {
    location.hash = TABS[index]
    return
  }

  if (event.key === 'r') {
    poll()
    return
  }

  if (currentTab() !== 'players' || !state.snapshot)
    return

  const rows = sortedPlayers(state.snapshot.players)
  const current = rows.findIndex(p => p.id === state.selectedPlayerId)
  if (event.key === 'ArrowDown' || event.key === 'j') {
    selectPlayer(rows[Math.min(rows.length - 1, current + 1)]?.id ?? null)
    event.preventDefault()
  }
  else if (event.key === 'ArrowUp' || event.key === 'k') {
    selectPlayer(rows[Math.max(0, current - 1)]?.id ?? null)
    event.preventDefault()
  }
  else if (event.key === 'Escape') {
    selectPlayer(null)
  }
})

render()
poll()
