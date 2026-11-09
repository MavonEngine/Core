import type { NetRecord, NetRecordDetail, NetRecordList } from '@mavonengine/core/Networking/Debug/NetRecorder'
import { useEffect, useRef, useState } from 'react'
import { fetchPacket, fetchPackets } from '../../Network/serverApi'

/** Whose records are shown: everything the server sent and received, or only this tab's own traffic */
export type RecordSource = 'server' | 'client'

const MAX_ROWS = 1000
const POLL_MS = 500
const NOT_CONNECTED = 'This tab is not connected to a game server'

async function list(source: RecordSource, after: number): Promise<NetRecordList> {
  if (source === 'server')
    return fetchPackets({ after, limit: MAX_ROWS })

  const net = window.Game.network?.net
  if (!net)
    throw new Error(NOT_CONNECTED)
  return net.list({ after, limit: MAX_ROWS })
}

/**
 * The newest records of one side, oldest first, kept up to date while not paused
 */
export function useRecords(source: RecordSource, paused: boolean) {
  const [records, setRecords] = useState<NetRecord[]>([])
  const [error, setError] = useState<string>()
  const after = useRef(0)

  useEffect(() => {
    after.current = 0
    setRecords([])
    setError(undefined)
  }, [source])

  useEffect(() => {
    if (paused)
      return

    let cancelled = false
    const poll = async () => {
      try {
        const result = await list(source, after.current)
        if (cancelled)
          return
        after.current = result.latestId
        if (result.records.length)
          setRecords(previous => [...previous, ...result.records].slice(-MAX_ROWS))
        setError(result.enabled ? undefined : 'Nothing is being recorded on this side')
      }
      catch (err) {
        if (!cancelled)
          setError((err as Error).message)
      }
    }

    void poll()
    const timer = setInterval(() => void poll(), POLL_MS)
    return () => {
      cancelled = true
      clearInterval(timer)
    }
  }, [source, paused])

  return { records, error, clear: () => setRecords([]) }
}

/** One record with its payload, undefined while it loads or when nothing is selected */
export function useRecordDetail(source: RecordSource, id: number | undefined) {
  const [detail, setDetail] = useState<NetRecordDetail | null>()

  useEffect(() => {
    setDetail(undefined)
    if (id === undefined)
      return

    let cancelled = false
    const load = source === 'server'
      ? fetchPacket(id)
      : Promise.resolve(window.Game.network?.net.get(id) ?? null)
    load.then(record => !cancelled && setDetail(record), () => !cancelled && setDetail(null))

    return () => {
      cancelled = true
    }
  }, [source, id])

  return detail
}
