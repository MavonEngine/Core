/**
 * Keeps the last packets and network events of one side (the server, or one client) for the dev tools:
 * the packet inspector, the network timeline, `mavonengine mcp` and the editor's Network panel.
 * Shared by the server and the browser, so it uses nothing from Node or the DOM.
 */

export type NetDirection = 'in' | 'out'

export interface NetRecord {
  id: number
  /** Epoch ms */
  timestamp: number
  /** A message on the wire, or something that happened to the connection or the sync (connect, sync_enter, dropped…) */
  kind: 'packet' | 'event'
  /** `out` was sent by this side, `in` received. Events have none */
  direction?: NetDirection
  /** Message name on the wire (sv_state, command, ping…) or the event's name */
  type: string
  /** On the server: channel id of the client it was sent to or came from. Unset on a client */
  peer?: string
  /** Size of the JSON payload in bytes, without the transport's framing */
  bytes?: number
  reliable?: boolean
  /** Server tick the packet belongs to (sv_state) */
  tick?: number
  /** Input sequence id of a command */
  sequenceId?: number
  /** Short facts about the payload, e.g. `{ entities: 12, ack: 40 }` or `{ command: 'cl_move' }` */
  info?: Record<string, unknown>
  /** Whether `get(id)` still has the payload: it is dropped from old records to bound memory */
  hasPayload: boolean
}

export interface NetRecordDetail extends NetRecord {
  payload?: unknown
}

export interface NetRecordInput {
  kind: NetRecord['kind']
  type: string
  direction?: NetDirection
  peer?: string
  bytes?: number
  reliable?: boolean
  tick?: number
  sequenceId?: number
  info?: Record<string, unknown>
  /** The payload as JSON, kept for `get()` */
  json?: string
  timestamp?: number
}

export interface NetRecordQuery {
  /** Only records newer than this id */
  after?: number
  kind?: NetRecord['kind']
  direction?: NetDirection
  /** Exact message / event name, or several separated by commas */
  type?: string
  peer?: string
  /** Newest records kept when more match. Default 200 */
  limit?: number
}

export interface NetRecordList {
  enabled: boolean
  /** Id of the newest record, pass it as `after` to get only newer ones */
  latestId: number
  /** Records matching the query before `limit` cut them */
  matched: number
  records: NetRecord[]
}

export interface NetRecorderOptions {
  enabled?: boolean
  /** How many records are kept. Default 2000 */
  size?: number
  /** Bytes of payload JSON kept over all records, the oldest payloads go first. Default 8 MB */
  payloadBudget?: number
}

export const DEFAULT_NET_RECORD_LIMIT = 200
export const MAX_NET_RECORD_LIMIT = 2000

interface Stored extends NetRecord {
  json?: string
}

let debugByDefault = false

/**
 * Whether a client's NetworkManager records its traffic from the start. Turned on by the dev bridge and the editor,
 * so a production build records nothing.
 */
export function setNetDebugDefault(enabled: boolean) {
  debugByDefault = enabled
}

export function netDebugDefault() {
  return debugByDefault
}

const encoder = typeof TextEncoder === 'undefined' ? undefined : new TextEncoder()

/** UTF-8 size of a string */
export function byteLength(text: string): number {
  if (encoder)
    return encoder.encode(text).length

  // No TextEncoder: count the bytes of each code point
  let bytes = 0
  for (const char of text) {
    const code = char.codePointAt(0)!
    bytes += code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4
  }
  return bytes
}

/**
 * The fields the dev tools show without opening the payload, read from the engine's own packet shapes.
 * Game packets get their `type` and `sequenceId` picked up when they follow `CommandPacket`.
 */
export function describePayload(type: string, data: unknown): Pick<NetRecordInput, 'tick' | 'sequenceId' | 'info'> {
  if (!data || typeof data !== 'object')
    return {}

  const packet = data as { type?: unknown, tick?: unknown, ack?: unknown, sequenceId?: unknown, entities?: unknown, id?: unknown }
  const info: Record<string, unknown> = {}

  if (Array.isArray(packet.entities))
    info.entities = packet.entities.length
  if (typeof packet.ack === 'number')
    info.ack = packet.ack
  if (typeof packet.type === 'string' && packet.type !== type)
    info.command = packet.type
  if (typeof packet.id === 'string')
    info.id = packet.id

  return {
    tick: typeof packet.tick === 'number' ? packet.tick : undefined,
    // sv_state carries the ack instead: its sequenceId is unused
    sequenceId: typeof packet.sequenceId === 'number' && typeof packet.tick !== 'number' ? packet.sequenceId : undefined,
    info: Object.keys(info).length ? info : undefined,
  }
}

export default class NetRecorder {
  private _enabled = false
  private enableCallbacks: (() => void)[] = []

  private records: Stored[] = []
  private nextId = 1
  private size: number
  private payloadBudget: number
  private payloadBytes = 0
  /** Records before this index have no payload left */
  private payloadFloor = 0

  constructor(options: NetRecorderOptions = {}) {
    this.size = options.size ?? 2000
    this.payloadBudget = options.payloadBudget ?? 8 * 1024 * 1024
    this.enabled = options.enabled ?? false
  }

  get enabled() {
    return this._enabled
  }

  set enabled(enabled: boolean) {
    this._enabled = enabled
    if (enabled) {
      for (const callback of this.enableCallbacks.splice(0))
        callback()
    }
  }

  /**
   * Run `callback` once, when recording is first turned on (now, when it is on already).
   * For hooks that should not exist while nothing is recorded.
   */
  onEnabled(callback: () => void) {
    if (this._enabled)
      callback()
    else
      this.enableCallbacks.push(callback)
  }

  get latestId() {
    return this.nextId - 1
  }

  record(input: NetRecordInput): NetRecord | undefined {
    if (!this.enabled)
      return undefined

    const { json, timestamp, ...rest } = input
    const record: Stored = { id: this.nextId++, timestamp: timestamp ?? Date.now(), ...rest, hasPayload: json !== undefined }
    if (json !== undefined) {
      record.json = json
      this.payloadBytes += json.length
    }

    this.records.push(record)
    this.trim()
    return record
  }

  /**
   * Record a message. Serializes `data` unless its JSON is passed, so only call it when `enabled`.
   */
  packet(direction: NetDirection, type: string, data: unknown, extra: Partial<NetRecordInput> = {}) {
    if (!this.enabled)
      return undefined

    let json = extra.json
    if (json === undefined && data !== undefined && data !== null) {
      try {
        json = JSON.stringify(data)
      }
      catch {
        json = undefined
      }
    }

    return this.record({
      kind: 'packet',
      direction,
      type,
      bytes: json === undefined ? 0 : byteLength(json),
      ...describePayload(type, data),
      ...extra,
      json,
    })
  }

  event(type: string, extra: Partial<NetRecordInput> = {}) {
    return this.record({ kind: 'event', type, ...extra })
  }

  list(query: NetRecordQuery = {}): NetRecordList {
    const after = query.after ?? 0
    const types = query.type ? new Set(query.type.split(',').map(type => type.trim()).filter(Boolean)) : undefined
    const limit = Math.max(1, Math.min(query.limit ?? DEFAULT_NET_RECORD_LIMIT, MAX_NET_RECORD_LIMIT))

    const matches = this.records.filter(record =>
      record.id > after
      && (!query.kind || record.kind === query.kind)
      && (!query.direction || record.direction === query.direction)
      && (!types || types.has(record.type))
      && (!query.peer || record.peer === query.peer))

    return {
      enabled: this.enabled,
      latestId: this.latestId,
      matched: matches.length,
      records: matches.slice(-limit).map(({ json: _json, ...record }) => record),
    }
  }

  get(id: number): NetRecordDetail | undefined {
    // Ids are consecutive, so the record sits at a fixed distance from the first one
    const first = this.records[0]
    const stored = first ? this.records[id - first.id] : undefined
    if (!stored)
      return undefined

    const { json, ...record } = stored
    return json === undefined ? record : { ...record, payload: JSON.parse(json) }
  }

  clear() {
    this.records = []
    this.payloadBytes = 0
    this.payloadFloor = 0
  }

  private trim() {
    const overflow = this.records.length - this.size
    if (overflow > 0) {
      for (const dropped of this.records.splice(0, overflow))
        this.payloadBytes -= dropped.json?.length ?? 0
      this.payloadFloor = Math.max(0, this.payloadFloor - overflow)
    }

    // Always keep the newest payload, however large
    while (this.payloadBytes > this.payloadBudget && this.payloadFloor < this.records.length - 1) {
      const record = this.records[this.payloadFloor++]
      if (record.json !== undefined) {
        this.payloadBytes -= record.json.length
        record.json = undefined
        record.hasPayload = false
      }
    }
  }
}

/** Query string params of GET …/net/packets as a query, or the reason they are invalid */
export function parseNetRecordQuery(params: Record<string, unknown>): NetRecordQuery | string {
  const query: NetRecordQuery = {}

  for (const key of ['after', 'limit'] as const) {
    if (params[key] === undefined || params[key] === '')
      continue
    const value = Number(params[key])
    if (!Number.isInteger(value) || value < 0)
      return `${key} must be a non-negative integer`
    query[key] = value
  }

  if (params.kind !== undefined && params.kind !== '') {
    if (params.kind !== 'packet' && params.kind !== 'event')
      return 'kind must be packet or event'
    query.kind = params.kind
  }

  if (params.direction !== undefined && params.direction !== '') {
    if (params.direction !== 'in' && params.direction !== 'out')
      return 'direction must be in or out'
    query.direction = params.direction
  }

  if (typeof params.type === 'string' && params.type)
    query.type = params.type
  if (typeof params.peer === 'string' && params.peer)
    query.peer = params.peer

  return query
}
