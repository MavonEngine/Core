import type { Object3D } from 'three'
import { useEffect, useRef } from 'react'
import { PerspectiveCamera, Scene, WebGLRenderer } from 'three'
import Game from '@mavonengine/core/Game'
import { getPreviewMap } from '@mavonengine/core/Particles/System/ParticlePreviewRegistry'
import styles from './ModelViewer.module.css'

function createEmitter(particleName: string, previewScene: Scene) {
  const entry = getPreviewMap()[particleName]
  if (!entry)
    return null

  const captured: Object3D[] = []
  const gameScene = Game.instance().scene
  const origAdd = gameScene.add.bind(gameScene)

  ;(gameScene).add = (...objects: Object3D[]) => {
    objects.forEach((obj) => {
      captured.push(obj)
      previewScene.add(obj)
    })
    return gameScene
  }

  const emitter = entry.create()

  gameScene.add = origAdd

  return emitter
}

export default ({ particleName }: { particleName: string }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas)
      return

    const previewScene = new Scene()
    const emitter = createEmitter(particleName, previewScene)

    if (!emitter)
      return

    const cfg = getPreviewMap()[particleName]
    const camera = new PerspectiveCamera(50, 1, 0.01, 200)
    camera.position.set(...cfg.cameraPosition)
    camera.lookAt(...cfg.cameraTarget)

    const renderer = new WebGLRenderer({ canvas, antialias: true })
    renderer.setPixelRatio(Game.instance().sizes.pixelRatio)
    renderer.setClearColor('#181818')

    const onUpdate = (delta: number) => {
      emitter.update(delta)
      renderer.render(previewScene, camera)
    }
    Game.instance().onUpdate(onUpdate)

    const observer = new ResizeObserver(([entry]) => {
      const { width: w, height: h } = entry.contentRect
      if (w === 0 || h === 0)
        return
      camera.aspect = w / h
      camera.updateProjectionMatrix()
      renderer.setSize(w, h, false)
    })
    observer.observe(canvas)

    return () => {
      Game.instance().unregisterOnUpdate(onUpdate)
      observer.disconnect()
      previewScene.clear()
      emitter.geometry.dispose()
      emitter.material.dispose()
      renderer.dispose()
    }
  }, [particleName])

  return (
    <div className={styles.viewer}>
      <div className={styles.canvasWrapper}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
      </div>
    </div>
  )
}
