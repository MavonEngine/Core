import Game from '@mavonengine/core/Game'
import { useEffect, useRef } from 'react'
import styles from './InspectorPanel.module.css'

interface Profiler {
  panel: HTMLElement
  setPosition(position: 'bottom' | 'right'): void
  togglePanel(): void
}

/**
 * three.js's inspector (frame and GPU timings, draw calls, memory, shaders), docked in the editor. It runs while its
 * tab is shown: switching away stops it, so its GPU timing costs nothing the rest of the time.
 */
export default function InspectorPanel() {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = ref.current
    if (!container)
      return

    const renderer = Game.instance().renderer
    const inspector = renderer.attachInspector(container)
    // three's inspector opens as a collapsed overlay: show its panel straight away, in the bottom layout
    // Its UI (the profiler) isn't in the typings
    const profiler = (inspector as unknown as { profiler: Profiler }).profiler
    profiler.setPosition('bottom')
    if (!profiler.panel.classList.contains('visible'))
      profiler.togglePanel()

    return () => {
      if (renderer.inspector === inspector)
        renderer.detachInspector()
    }
  }, [])

  return <div ref={ref} className={styles.root} />
}
