import type { TransformControlsMode } from 'three/examples/jsm/Addons.js'
import type { ShadeMode } from '../../Editor'
import { useEffect, useRef, useState } from 'react'
import styles from './CanvasPanel.module.css'
import ShadeModeButtons from './ShadeModeButtons'

const TOOLS: { mode: TransformControlsMode, label: string, paths: string[] }[] = [
  {
    mode: 'translate',
    label: 'Translate',
    paths: [
      'M12 2L12 22',
      'M2 12L22 12',
      'M9 5L12 2L15 5',
      'M19 9L22 12L19 15',
      'M15 19L12 22L9 19',
      'M5 15L2 12L5 9',
    ],
  },
  {
    mode: 'rotate',
    label: 'Rotate',
    paths: [
      'M21.5 2v6h-6',
      'M21.34 15.57a10 10 0 1 1-.57-8.38',
    ],
  },
  {
    mode: 'scale',
    label: 'Scale',
    paths: [
      'M15 3L21 3L21 9',
      'M9 21L3 21L3 15',
      'M21 3L14 10',
      'M3 21L10 14',
    ],
  },
]

export const SHADE_MODES: { mode: ShadeMode, label: string, paths: string[] }[] = [
  {
    mode: 'solid',
    label: 'Solid',
    paths: [
      'M12 3a9 9 0 1 0 0 18A9 9 0 0 0 12 3z',
      'M8 6.5C6.3 8.2 5.2 10 5.2 12s1.1 3.8 2.8 5.5',
    ],
  },
  {
    mode: 'flat',
    label: 'Flat',
    paths: [
      'M12 3L21 12L12 21L3 12Z',
    ],
  },
  {
    mode: 'wireframe',
    label: 'Wireframe',
    paths: [
      'M3 3h18v18H3z',
      'M9 3v18',
      'M15 3v18',
      'M3 9h18',
      'M3 15h18',
    ],
  },
]

export default function CanvasToolbar() {
  const [activeMode, setActiveMode] = useState<TransformControlsMode>('translate')
  const [shadeMode, setShadeMode] = useState<ShadeMode>('solid')
  const [overlaysOpen, setOverlaysOpen] = useState(false)
  const [showHelpers, setShowHelpers] = useState(true)
  const overlaysRef = useRef<HTMLDivElement>(null)

  const setMode = (mode: TransformControlsMode) => {
    setActiveMode(mode)
    window.Game.editor?.trigger('setTransformMode', mode)
  }

  const setShadeModeHandler = (mode: ShadeMode) => {
    setShadeMode(mode)
    window.Game.editor?.trigger('setShadeMode', mode)
  }

  const toggleShowHelpers = (value: boolean) => {
    setShowHelpers(value)
    window.Game.editor?.setShowHelpers(value)
  }

  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (overlaysRef.current && !overlaysRef.current.contains(e.target as Node))
        setOverlaysOpen(false)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  return (
    <div className={styles.toolbar}>
      {TOOLS.map(({ mode, label, paths }) => (
        <button
          key={mode}
          title={label}
          className={`${styles.toolBtn}${activeMode === mode ? ` ${styles.active}` : ''}`}
          onClick={() => setMode(mode)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {paths.map((d, i) => <path key={i} d={d} />)}
          </svg>
        </button>
      ))}

      <div className={styles.separator} />

      <ShadeModeButtons
        shadeMode={shadeMode}
        onChange={setShadeModeHandler}
        btnClass={styles.toolBtn}
        activeClass={styles.active}
        size={16}
      />

      <div className={styles.separator} />

      <div style={{ position: 'relative' }} ref={overlaysRef}>
        <button
          title="Viewport Overlays"
          className={`${styles.toolBtn}${overlaysOpen ? ` ${styles.active}` : ''}`}
          onClick={() => setOverlaysOpen(o => !o)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="9" cy="12" r="6" />
            <circle cx="15" cy="12" r="6" />
          </svg>
        </button>

        {overlaysOpen && (
          <div className={styles.overlayDropdown}>
            <div className={styles.overlaySection}>Helpers</div>
            <label className={styles.overlayRow}>
              <input
                type="checkbox"
                checked={showHelpers}
                onChange={e => toggleShowHelpers(e.target.checked)}
              />
              Show Helpers
            </label>
          </div>
        )}
      </div>
    </div>
  )
}
