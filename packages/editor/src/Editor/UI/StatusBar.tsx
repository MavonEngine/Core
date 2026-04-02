import { ENGINE_VERSION } from '@mavonengine/core/BaseGame'
import { version } from '../../../package.json' with { type: 'json' }
import styles from './StatusBar.module.css'
import { useSceneStats } from './useSceneStats'

export default function StatusBar() {
  const stats = useSceneStats()

  return (
    <div className={styles.statusBar}>
      <div className={styles.section}>
        <span className={styles.branch}>main</span>
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
        <span className={styles.engineName}>
          Editor v
          {version}
          {' '}
          | MavonEngine v
          {ENGINE_VERSION}
        </span>
      </div>
    </div>
  )
}
