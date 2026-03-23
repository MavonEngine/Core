import type { ReactNode } from 'react'
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { Rnd } from 'react-rnd'
import styles from './Window.module.css'

let topZ = 1000

interface Props {
  title: string
  children?: ReactNode
  defaultX?: number
  defaultY?: number
  defaultWidth?: number
  defaultHeight?: number
  minWidth?: number
  minHeight?: number
  storageKey?: string
  onClose(): void
}

export default ({ title, children, defaultX, defaultY, defaultWidth = 400, defaultHeight = 300, minWidth = 280, minHeight = 200, storageKey, onClose }: Props) => {
  const [zIndex, setZIndex] = useState(() => ++topZ)

  const storedSize = storageKey ? JSON.parse(localStorage.getItem(`window:${storageKey}`) ?? 'null') : null
  const initWidth = storedSize?.width ?? defaultWidth
  const initHeight = storedSize?.height ?? defaultHeight

  function bringToFront() {
    setZIndex(++topZ)
  }

  function onResizeStop(_e: unknown, _dir: unknown, ref: HTMLElement) {
    if (storageKey)
      localStorage.setItem(`window:${storageKey}`, JSON.stringify({ width: ref.offsetWidth, height: ref.offsetHeight }))
  }

  return createPortal(
    <Rnd
      onMouseDown={bringToFront}
      onResizeStop={onResizeStop}
      style={{ zIndex }}
      default={{
        x: defaultX ?? (window.innerWidth - initWidth) / 2,
        y: defaultY ?? (window.innerHeight - initHeight) / 2,
        width: initWidth,
        height: initHeight,
      }}
      minWidth={minWidth}
      minHeight={minHeight}
      bounds="window"
      dragHandleClassName={styles.handle}
      className={styles.window}
    >
      <div className={styles.handle}>
        <span className={styles.title}>{title}</span>
        <button className={styles.close} onClick={onClose}>✕</button>
      </div>
      <div className={styles.body}>
        {children}
      </div>
    </Rnd>,
    document.body,
  )
}
