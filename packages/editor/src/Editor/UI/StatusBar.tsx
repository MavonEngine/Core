import { ENGINE_VERSION } from '@mavonengine/core/BaseGame'
import { useEffect, useState } from 'react'
import { version } from '../../../package.json' with { type: 'json' }
import ControllerDebug from './Controllers/ControllerDebug'
import { useGamepads } from './Controllers/useGamepads'
import styles from './StatusBar.module.css'
import { useSceneStats } from './useSceneStats'
import Window from './Window'

export default function StatusBar() {
  const stats = useSceneStats()
  const gamepads = useGamepads()
  const [controllerDebugOpen, setControllerDebugOpen] = useState(false)
  const scene = useActiveScene()

  return (
    <div className={styles.statusBar}>
      <div className={styles.section}>
        <span className={styles.branch} title={scene ? `scenes/${scene.file}.json` : 'No scene loaded'}>
          {scene ? `${scene.name}${scene.dirty ? ' ●' : ''}` : 'no scene'}
        </span>
        <span className={styles.stat}>
          <span className={styles.statLabel}>FPS</span>
          {stats.fps}
        </span>
        <span className={styles.stat}>
          <span className={styles.statLabel}>Tris</span>
          {stats.triangles.toLocaleString()}
        </span>
        <span className={styles.stat}>
          <span className={styles.statLabel}>Draw Calls</span>
          {stats.drawCalls}
        </span>
      </div>
      <div className={styles.section}>
        <span className={styles.stat}>
          <span className={styles.statLabel}>Objects</span>
          {stats.objects}
        </span>
        <span className={styles.stat}>
          <span className={styles.statLabel}>Materials</span>
          {stats.materials}
        </span>
        <span className={styles.stat}>
          <span className={styles.statLabel}>Textures</span>
          {stats.textures}
        </span>
        <button
          className={`${styles.stat} ${styles.statButton}`}
          title="Controller input"
          aria-label="Controller input"
          onClick={() => setControllerDebugOpen(open => !open)}
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 11h4M8 9v4M15 12h.01M18 10h.01" />
            <path d="M17.32 5H6.68a4 4 0 0 0-3.98 3.59l-.9 8.06A2.12 2.12 0 0 0 3.9 19c.8 0 1.53-.45 1.89-1.17L7 15h10l1.21 2.83A2.1 2.1 0 0 0 20.1 19a2.12 2.12 0 0 0 2.1-2.35l-.9-8.06A4 4 0 0 0 17.32 5z" />
          </svg>
          {gamepads.length}
        </button>
        <span className={styles.engineName}>
          Editor v
          {version}
          {' '}
          | MavonEngine v
          {ENGINE_VERSION}
        </span>
      </div>
      {controllerDebugOpen && (
        <Window
          title="Controller Input"
          storageKey="controller-input"
          defaultWidth={420}
          defaultHeight={560}
          minWidth={340}
          onClose={() => setControllerDebugOpen(false)}
        >
          <ControllerDebug />
        </Window>
      )}
    </div>
  )
}

/** Name and unsaved state of the active scene */
function useActiveScene() {
  const [state, setState] = useState<{ name: string, file: string, dirty: boolean }>()

  useEffect(() => {
    const read = () => {
      const scene = window.Game.activeScene
      setState(scene ? { name: scene.name, file: scene.source ?? 'main', dirty: scene.isDirty() } : undefined)
    }
    read()
    const timer = setInterval(read, 1000)
    window.Game.editor?.on('sceneSaved', read)
    window.Game.editor?.on('sceneChanged', read)
    return () => {
      clearInterval(timer)
      window.Game.editor?.off('sceneSaved', read)
      window.Game.editor?.off('sceneChanged', read)
    }
  }, [])

  return state
}
