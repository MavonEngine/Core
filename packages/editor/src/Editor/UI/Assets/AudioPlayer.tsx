import { useWavesurfer } from '@wavesurfer/react'
import { useEffect, useMemo, useRef } from 'react'
import AssetStats from './AssetStats'
import styles from './AudioPlayer.module.css'

interface Props {
  buffer: AudioBuffer
}

function audioBufferToUrl(buffer: AudioBuffer): string {
  const numChannels = buffer.numberOfChannels
  const sampleRate = buffer.sampleRate
  const samples = buffer.length
  const bitDepth = 16
  const blockAlign = numChannels * (bitDepth / 8)
  const dataSize = samples * blockAlign
  const ab = new ArrayBuffer(44 + dataSize)
  const view = new DataView(ab)

  const write = (offset: number, str: string) => {
    for (let i = 0; i < str.length; i++)
      view.setUint8(offset + i, str.charCodeAt(i))
  }

  write(0, 'RIFF')
  view.setUint32(4, 36 + dataSize, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, numChannels, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * blockAlign, true)
  view.setUint16(32, blockAlign, true)
  view.setUint16(34, bitDepth, true)
  write(36, 'data')
  view.setUint32(40, dataSize, true)

  let offset = 44
  for (let i = 0; i < samples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const s = Math.max(-1, Math.min(1, buffer.getChannelData(ch)[i]))
      view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true)
      offset += 2
    }
  }

  return URL.createObjectURL(new Blob([ab], { type: 'audio/wav' }))
}

function formatTime(seconds: number) {
  const m = Math.floor(seconds / 60)
  const s = Math.floor(seconds % 60)
  return `${m}:${s.toString().padStart(2, '0')}`
}

export default ({ buffer }: Props) => {
  const containerRef = useRef<HTMLDivElement>(null)

  const url = useMemo(() => audioBufferToUrl(buffer), [buffer])

  useEffect(() => () => URL.revokeObjectURL(url), [url])

  const { wavesurfer, isPlaying, currentTime } = useWavesurfer({
    container: containerRef,
    url,
    waveColor: '#4a9eff',
    progressColor: '#007acc',
    cursorColor: '#ffffff44',
    height: 'auto',
    interact: true,
  })

  return (
    <div className={styles.player}>
      <div className={styles.main}>
        <div className={styles.waveform} ref={containerRef} />
        <div className={styles.controls}>
          <button className={styles.playButton} onClick={() => wavesurfer?.playPause()}>
            {isPlaying ? '⏸' : '▶'}
          </button>
          <span className={styles.time}>
            {formatTime(currentTime)}
            {' '}
            /
            {formatTime(buffer.duration)}
          </span>
        </div>
      </div>
      <AssetStats stats={[
        { label: 'Duration', value: formatTime(buffer.duration) },
        { label: 'Sample Rate', value: `${(buffer.sampleRate / 1000).toFixed(1)} kHz` },
        { label: 'Channels', value: buffer.numberOfChannels === 1 ? 'Mono' : 'Stereo' },
        { label: 'Samples', value: `${(buffer.length / 1000).toFixed(1)}k` },
      ]}
      />
    </div>
  )
}
