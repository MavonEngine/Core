// Formatting shared with the mavonengine CLI dashboard, so both show the same numbers.
// Plain browser JavaScript, served as is. Also imported by the tests.

const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB']

/** Entries kept per feed (logs, HTTP requests), like the CLI */
export const MAX_FEED_ENTRIES = 1000

const NEWLINE_RE = /\r?\n/

export function formatBytes(bytes, decimals = 1) {
  if (!Number.isFinite(bytes) || bytes <= 0)
    return '0 B'

  // Clamped at 0 too: fractions of a byte (an empty chart's scale) would index before B
  const exponent = Math.max(0, Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1))
  const value = bytes / 1024 ** exponent

  return `${exponent === 0 ? value : value.toFixed(decimals)} ${BYTE_UNITS[exponent]}`
}

export function formatRate(bytesPerSecond) {
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatDuration(totalSeconds) {
  const seconds = Math.max(0, Math.floor(totalSeconds))
  const d = Math.floor(seconds / 86400)
  const h = Math.floor((seconds % 86400) / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = seconds % 60

  if (d > 0)
    return `${d}d ${h}h ${m}m`
  if (h > 0)
    return `${h}h ${m}m ${s}s`
  if (m > 0)
    return `${m}m ${s}s`
  return `${s}s`
}

export function formatMs(ms) {
  return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`
}

export function formatPercent(value) {
  return `${value.toFixed(1)}%`
}

export function formatTime(timestamp) {
  const date = new Date(timestamp)
  return [date.getHours(), date.getMinutes(), date.getSeconds()].map(n => n.toString().padStart(2, '0')).join(':')
}

/** CSS class for an HTTP status: no response or 5xx is an error, 4xx a warning, 3xx info */
export function statusClass(status) {
  if (status === null || status >= 500)
    return 'danger'
  if (status >= 400)
    return 'warning'
  if (status >= 300)
    return 'info'
  return 'success'
}

/** Players in the order the CLI shows them */
export function sortedPlayers(players) {
  return [...players].sort((a, b) => a.id.localeCompare(b.id))
}

/** Display names default to the id, so the name column only adds noise until a game sets them */
export function showNames(players) {
  return players.some(p => p.displayName !== p.id)
}

/** Add new feed entries, keeping the newest `max` */
export function appendFeed(entries, added, max = MAX_FEED_ENTRIES) {
  const combined = entries.concat(added)
  return combined.length > max ? combined.slice(combined.length - max) : combined
}

/** Strip blank lines around a multi-line message, like the boot banner */
export function trimMessage(message) {
  const lines = message.split(NEWLINE_RE)
  while (lines.length > 1 && lines[0].trim() === '')
    lines.shift()
  while (lines.length > 1 && lines.at(-1).trim() === '')
    lines.pop()
  return lines.join('\n')
}

/** Delay before the next poll: the interval, doubling per failure up to `maxMs`, like the CLI */
export function backoff(intervalMs, failures, maxMs = 10000) {
  return failures === 0 ? intervalMs : Math.min(intervalMs * 2 ** failures, Math.max(maxMs, intervalMs))
}
