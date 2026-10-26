const BYTE_UNITS = ['B', 'KiB', 'MiB', 'GiB', 'TiB']

export function formatBytes(bytes: number, decimals = 1): string {
  if (!Number.isFinite(bytes) || bytes <= 0)
    return '0 B'

  const exponent = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), BYTE_UNITS.length - 1)
  const value = bytes / 1024 ** exponent

  return `${exponent === 0 ? value : value.toFixed(decimals)} ${BYTE_UNITS[exponent]}`
}

export function formatRate(bytesPerSecond: number): string {
  return `${formatBytes(bytesPerSecond)}/s`
}

export function formatDuration(totalSeconds: number): string {
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

export function formatMs(ms: number): string {
  return `${ms.toFixed(ms < 10 ? 2 : 1)} ms`
}

export function formatPercent(value: number): string {
  return `${value.toFixed(1)}%`
}
