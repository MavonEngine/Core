import type { NetRecord } from '@mavonengine/core/Networking/Debug/NetRecorder'
import type NetworkOverlay from '../../Network/NetworkOverlay'
import type { NetworkOverlayOptions } from '../../Network/NetworkOverlay'
import type { RecordFilter } from './format'
import type { RecordSource } from './useRecords'
import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import { describeRecord, filterRecords, formatBytes, formatTime } from './format'
import styles from './NetworkPanel.module.css'
import Timeline, { laneOf } from './Timeline'
import { useRecordDetail, useRecords } from './useRecords'

const ARROWS = { out: '↑', in: '↓', event: '•' }

function overlay(): NetworkOverlay | undefined {
  return (window.Game.editor as { networkOverlay?: NetworkOverlay } | undefined)?.networkOverlay
}

function useOverlayOptions(): [NetworkOverlayOptions | undefined, (options: Partial<NetworkOverlayOptions>) => void] {
  const target = overlay()
  const [options, setOptions] = useState(target?.options)

  useEffect(() => {
    if (!target)
      return
    target.on('changed', setOptions)
    return () => target.off('changed', setOptions)
  }, [target])

  return [options, changes => target?.setOptions(changes)]
}

/** Connection of this tab, read a few times a second */
function useConnection() {
  const read = () => {
    const network = window.Game.network
    if (!network)
      return undefined
    const { tick, receivedAt, missedStates } = network.serverView
    return {
      connected: network.connected,
      ping: network.ping,
      tick,
      stateAge: receivedAt === null ? null : Math.round(performance.now() - receivedAt),
      missedStates,
    }
  }

  const [connection, setConnection] = useState(read)
  useEffect(() => {
    const timer = setInterval(() => setConnection(read()), 500)
    return () => clearInterval(timer)
  }, [])

  return connection
}

function Status() {
  const connection = useConnection()
  if (!connection)
    return <span className={styles.status}>This tab has no game connection</span>

  return (
    <span className={styles.status}>
      <span className={connection.connected ? styles.dotOn : styles.dotOff} />
      {connection.connected ? `${connection.ping} ms` : 'disconnected'}
      {connection.tick !== null && ` · tick ${connection.tick}`}
      {connection.stateAge !== null && ` · state ${connection.stateAge} ms ago`}
      {connection.missedStates > 0 && ` · ${connection.missedStates} missed`}
    </span>
  )
}

function SyncTable({ viewAs, onViewAs }: { viewAs: string | null, onViewAs(id: string | null): void }) {
  const store = overlay()?.sync
  const { sync, error } = useSyncExternalStore(store?.subscribe ?? (() => () => { }), store?.get ?? (() => ({} as { sync?: undefined, error?: string })))

  if (!sync)
    return <div className={styles.note}>{error ?? 'Asking the server…'}</div>

  const untracked = sync.entities.filter(entity => !entity.player && entity.trackedBy === 0).length

  return (
    <div className={styles.sync}>
      <div className={styles.syncSummary}>
        {`Tick ${sync.tick} · ${sync.tickRate} Hz · sync distance ${sync.syncDistance ?? 'unknown'} · ${sync.entities.length} synced entities`}
        {untracked > 0 && sync.players.length > 0 && `, ${untracked} out of every player's range`}
        {sync.editors.length > 0 && ` · ${sync.editors.length} editor${sync.editors.length > 1 ? 's' : ''}`}
      </div>

      {sync.players.length === 0
        ? <div className={styles.note}>No players connected</div>
        : (
            <table className={styles.table}>
              <thead>
                <tr>
                  <th>Player</th>
                  <th>Tracked</th>
                  <th>Ack</th>
                  <th>Last state</th>
                </tr>
              </thead>
              <tbody>
                {sync.players.map(player => (
                  <tr
                    key={player.id}
                    className={player.id === viewAs ? styles.selected : undefined}
                    title="Colour the ghosts by what this player is sent"
                    onClick={() => onViewAs(player.id === viewAs ? null : player.id)}
                  >
                    <td>{player.displayName}</td>
                    <td>{player.tracked.length}</td>
                    <td>{player.ack}</td>
                    <td>{player.lastState ? `${formatBytes(player.lastState.bytes)} · tick ${player.lastState.tick}` : 'none'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
    </div>
  )
}

function RecordRow({ record, selected, onSelect }: { record: NetRecord, selected: boolean, onSelect(): void }) {
  const lane = laneOf(record)
  return (
    <tr className={`${styles[lane]}${selected ? ` ${styles.selected}` : ''}`} onClick={onSelect}>
      <td className={styles.time}>{formatTime(record.timestamp)}</td>
      <td className={styles.arrow} title={lane === 'event' ? 'event' : lane === 'out' ? 'sent' : 'received'}>{ARROWS[lane]}</td>
      <td className={styles.type}>{record.type}</td>
      <td className={styles.peer} title={record.peer}>{record.peer}</td>
      <td className={styles.bytes}>{record.kind === 'packet' ? formatBytes(record.bytes) : ''}</td>
      <td className={styles.info}>{describeRecord(record)}</td>
    </tr>
  )
}

/**
 * The editor's Network panel: packets and network events of the server or of this tab, a timeline of them,
 * the server's state sync, and the switches of the viewport overlay.
 */
export default function NetworkPanel() {
  const [source, setSource] = useState<RecordSource>('server')
  const [paused, setPaused] = useState(false)
  const [filter, setFilter] = useState<RecordFilter>({ kind: 'all', pings: false, text: '' })
  const [selectedId, setSelectedId] = useState<number>()
  const [options, setOptions] = useOverlayOptions()

  const { records, error, clear } = useRecords(source, paused)
  const visible = useMemo(() => filterRecords(records, filter), [records, filter])
  const detail = useRecordDetail(source, selectedId)

  const changeSource = (next: RecordSource) => {
    setSource(next)
    setSelectedId(undefined)
  }

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <select value={source} onChange={event => changeSource(event.target.value as RecordSource)} aria-label="Source">
          <option value="server">Server</option>
          <option value="client">This tab</option>
        </select>
        <select value={filter.kind} onChange={event => setFilter({ ...filter, kind: event.target.value as RecordFilter['kind'] })} aria-label="Kind">
          <option value="all">Packets and events</option>
          <option value="packet">Packets</option>
          <option value="event">Events</option>
        </select>
        <input
          type="search"
          placeholder="Filter by message or client"
          value={filter.text}
          onChange={event => setFilter({ ...filter, text: event.target.value })}
        />
        <label>
          <input type="checkbox" checked={filter.pings} onChange={event => setFilter({ ...filter, pings: event.target.checked })} />
          Pings
        </label>
        <button onClick={() => setPaused(value => !value)}>{paused ? 'Resume' : 'Pause'}</button>
        <button onClick={clear}>Clear</button>
        <span className={styles.spacer} />
        {options && (
          <>
            <label title="A wireframe box where the server last said each entity is">
              <input type="checkbox" checked={options.ghosts} onChange={event => setOptions({ ghosts: event.target.checked })} />
              Server ghosts
            </label>
            <label title="A ring around each player at the server's sync distance">
              <input type="checkbox" checked={options.rings} onChange={event => setOptions({ rings: event.target.checked })} />
              Sync radius
            </label>
          </>
        )}
        <Status />
      </div>

      <Timeline records={visible} selectedId={selectedId} live={!paused} />

      <div className={styles.body}>
        <div className={styles.records}>
          {error && <div className={styles.error}>{error}</div>}
          {!error && visible.length === 0 && <div className={styles.note}>No packets yet</div>}
          <table className={styles.table}>
            <tbody>
              {visible.slice(-300).reverse().map(record => (
                <RecordRow
                  key={record.id}
                  record={record}
                  selected={record.id === selectedId}
                  onSelect={() => setSelectedId(record.id === selectedId ? undefined : record.id)}
                />
              ))}
            </tbody>
          </table>
        </div>

        <div className={styles.side}>
          {selectedId !== undefined
            ? (
                <>
                  <div className={styles.sectionTitle}>{`Record ${selectedId}`}</div>
                  {detail === undefined && <div className={styles.note}>Loading…</div>}
                  {detail === null && <div className={styles.note}>This record is no longer kept</div>}
                  {detail && !detail.hasPayload && <div className={styles.note}>{detail.kind === 'event' ? describeRecord(detail) || 'No details' : 'The payload is no longer kept'}</div>}
                  {detail?.hasPayload && <pre className={styles.payload}>{JSON.stringify(detail.payload, null, 2)}</pre>}
                </>
              )
            : (
                <>
                  <div className={styles.sectionTitle}>State sync</div>
                  <SyncTable viewAs={options?.viewAs ?? null} onViewAs={id => setOptions({ viewAs: id })} />
                </>
              )}
        </div>
      </div>
    </div>
  )
}
