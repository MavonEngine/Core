import type { NetRecord } from '@mavonengine/core/Networking/Debug/NetRecorder'
import { useEffect, useRef } from 'react'
import styles from './NetworkPanel.module.css'

const LANES = ['out', 'in', 'event'] as const
const COLORS = { out: '#007ACC', in: '#4EC9B0', event: '#DCDCAA', selected: '#FFFFFF', grid: '#333333', label: '#666666' }
const LANE_HEIGHT = 16
const LABEL_WIDTH = 40
const HEIGHT = LANES.length * LANE_HEIGHT

export function laneOf(record: NetRecord): typeof LANES[number] {
  return record.kind === 'event' ? 'event' : record.direction ?? 'out'
}

/**
 * The last `windowMs` of traffic as marks on three lanes: sent, received and events. Taller marks are larger packets.
 * While `live` the newest moment sits at the right edge and the marks scroll; paused it ends at the last record.
 */
export default function Timeline({ records, selectedId, live, windowMs = 10000 }: { records: NetRecord[], selectedId?: number, live: boolean, windowMs?: number }) {
  const canvas = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const draw = () => {
      const element = canvas.current
      const context = element?.getContext?.('2d')
      if (!element || !context)
        return

      const ratio = window.devicePixelRatio || 1
      const width = element.clientWidth
      if (element.width !== width * ratio || element.height !== HEIGHT * ratio) {
        element.width = width * ratio
        element.height = HEIGHT * ratio
      }
      context.setTransform(ratio, 0, 0, ratio, 0, 0)
      context.clearRect(0, 0, width, HEIGHT)

      const end = live ? Date.now() : records.at(-1)?.timestamp ?? Date.now()
      const start = end - windowMs
      const span = width - LABEL_WIDTH

      context.font = '10px sans-serif'
      context.textBaseline = 'middle'
      LANES.forEach((lane, index) => {
        context.fillStyle = COLORS.label
        context.fillText(lane, 2, index * LANE_HEIGHT + LANE_HEIGHT / 2)
        context.fillStyle = COLORS.grid
        context.fillRect(LABEL_WIDTH, (index + 1) * LANE_HEIGHT - 1, span, 1)
      })

      // One line per second
      for (let time = Math.ceil(start / 1000) * 1000; time <= end; time += 1000)
        context.fillRect(LABEL_WIDTH + ((time - start) / windowMs) * span, 0, 1, HEIGHT)

      for (const record of records) {
        if (record.timestamp < start || record.timestamp > end)
          continue
        const lane = laneOf(record)
        const x = LABEL_WIDTH + ((record.timestamp - start) / windowMs) * span
        // 4px for an empty packet up to the full lane from 2 kB on
        const height = lane === 'event' ? LANE_HEIGHT - 4 : 4 + Math.min(1, (record.bytes ?? 0) / 2048) * (LANE_HEIGHT - 8)
        const selected = record.id === selectedId
        context.fillStyle = selected ? COLORS.selected : COLORS[lane]
        context.fillRect(x - (selected ? 1 : 0), (LANES.indexOf(lane) + 1) * LANE_HEIGHT - 2 - height, selected ? 3 : lane === 'event' ? 2 : 1, height)
      }
    }

    draw()
    if (!live)
      return
    const timer = setInterval(draw, 100)
    return () => clearInterval(timer)
  }, [records, selectedId, live, windowMs])

  return <canvas ref={canvas} className={styles.timeline} style={{ height: HEIGHT }} aria-label="Network timeline" />
}
