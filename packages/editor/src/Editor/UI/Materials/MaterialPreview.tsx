import type { Material } from 'three'
import Game from '@mavonengine/core/Game'
import { useEffect, useRef } from 'react'
import { AmbientLight, DirectionalLight, Mesh, PerspectiveCamera, Scene, SphereGeometry } from 'three'
import { WebGPURenderer } from 'three/webgpu'
import styles from './Materials.module.css'

/** A slowly turning sphere drawn with `material`, in its own renderer on the game's backend */
export default function MaterialPreview({ material }: { material?: Material }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const meshRef = useRef<Mesh>(null)

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas)
      return

    const scene = new Scene()
    scene.add(new AmbientLight(0xFFFFFF, 0.5))
    const key = new DirectionalLight(0xFFFFFF, 2.5)
    key.position.set(3, 4, 5)
    scene.add(key)
    const rim = new DirectionalLight(0x9DC4FF, 1)
    rim.position.set(-4, 1, -3)
    scene.add(rim)

    const geometry = new SphereGeometry(1, 96, 48)
    const mesh = new Mesh(geometry)
    meshRef.current = mesh
    scene.add(mesh)

    const camera = new PerspectiveCamera(35, 1, 0.1, 20)
    camera.position.set(0, 0.4, 4.2)
    camera.lookAt(0, 0, 0)

    const renderer = new WebGPURenderer({
      canvas,
      antialias: true,
      alpha: true,
      forceWebGL: !Game.instance().renderer.isWebGPU,
    })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    let stopped = false
    void renderer.init().then(() => {
      if (stopped)
        return
      let last = performance.now()
      void renderer.setAnimationLoop((now) => {
        mesh.rotation.y += (now - last) / 1000 * 0.4
        last = now
        renderer.render(scene, camera)
      })
    })

    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry!.contentRect
      if (!width || !height)
        return
      camera.aspect = width / height
      camera.updateProjectionMatrix()
      renderer.setSize(width, height, false)
    })
    observer.observe(canvas)

    return () => {
      stopped = true
      observer.disconnect()
      void renderer.setAnimationLoop(null)
      geometry.dispose()
      renderer.dispose()
      meshRef.current = null
    }
  }, [])

  useEffect(() => {
    if (meshRef.current && material)
      meshRef.current.material = material
  }, [material])

  return (
    <div className={styles.previewBox}>
      <canvas ref={canvasRef} className={styles.preview} />
    </div>
  )
}
