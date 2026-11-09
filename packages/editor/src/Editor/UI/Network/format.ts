import type { NetRecord } from '@mavonengine/core/Networking/Debug/NetRecorder'

export function formatBytes(bytes: number | undefined): string {
  if (bytes === undefined)
    return ''
  if (bytes < 1024)
    return `${bytes} B`
  return `${(bytes / 1024).toFixed(bytes < 10240 ? 2 : 1)} kB`
}

/** Local time with milliseconds, e.g. 14:02:11.123 */
export function formatTime(timestamp: number): string {
  const date = new Date(timestamp)
  const pad = (value: number, length = 2) => String(value).padStart(length, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}.${pad(date.getMilliseconds(), 3)}`
}

/** The facts of a record in one line: tick, sequence id and what `info` holds */
export function describeRecord(record: NetRecord): string {
  const parts: string[] = []
  if (record.tick !== undefined)
    parts.push(`tick ${record.tick}`)
  if (record.sequenceId !== undefined)
    parts.push(`seq ${record.sequenceId}`)
  if (record.reliable)
    parts.push('reliable')

  for (const [key, value] of Object.entries(record.info ?? {})) {
    if (value === undefined || value === null)
      continue
    parts.push(`${key} ${Array.isArray(value) ? value.join(', ') : String(value)}`)
  }

  return parts.join(' · ')
}

export interface RecordFilter {
  kind: 'all' | 'packet' | 'event'
  /** ping / pong: one pair a second per client */
  pings: boolean
  /** Part of the message name or the peer, case-insensitive */
  text: string
}

export function filterRecords(records: NetRecord[], { kind, pings, text }: RecordFilter): NetRecord[] {
  const needle = text.trim().toLowerCase()
  return records.filter(record =>
    (kind === 'all' || record.kind === kind)
    && (pings || (record.type !== 'ping' && record.type !== 'pong'))
    && (!needle || record.type.toLowerCase().includes(needle) || !!record.peer?.toLowerCase().includes(needle)))
}
