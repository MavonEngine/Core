import type { AnimationAction, AnimationClip, Material, MeshBasicMaterial, Object3D } from 'three'
import type { ShadeMode } from '../../../Editor'
import { useEffect, useMemo, useRef, useState } from 'react'
import { AmbientLight, AnimationMixer, Box3, DirectionalLight, LoopOnce, LoopRepeat, Mesh, PerspectiveCamera, Scene, Vector3, WebGLRenderer } from 'three'
import { OrbitControls } from 'three/examples/jsm/Addons.js'
import { clone as skeletonClone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import Game from '@mavonengine/core/Game'
import { applyShadeMode } from '../../applyShadeMode'
import canvasStyles from '../CanvasPanel.module.css'
import ShadeModeButtons from '../ShadeModeButtons'
import AssetStats from './AssetStats'
import styles from './ModelViewer.module.css'

function fmt(n: number) {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n)
}

export default ({ model, animations }: { model: Object3D, animations?: AnimationClip[] }) => {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const cloneRef = useRef<Object3D | null>(null)
  const mixerRef = useRef<AnimationMixer | null>(null)
  const activeActionRef = useRef<AnimationAction | null>(null)
  const scrubberRef = useRef<HTMLInputElement>(null)
  const isPlayingRef = useRef(true)
  const [shadeMode, setShadeMode] = useState<ShadeMode>('solid')
  const [selectedAnim, setSelectedAnim] = useState<string | null>(null)
  const [loopAnim, setLoopAnim] = useState(true)
  const [animDuration, setAnimDuration] = useState(0)
  const [isPlaying, setIsPlaying] = useState(true)

  function pause() {
    isPlayingRef.current = false
    setIsPlaying(false)
  }

  function togglePlay() {
    isPlayingRef.current = !isPlaying
    setIsPlaying(!isPlaying)
  }

  const originalMaterials = useRef(new Map<string, Material | Material[]>())
  const shadeOverrideMaterials = useRef(new Map<string, MeshBasicMaterial>())
  const flatColors = useRef(new Map<string, number>())

  const stats = useMemo(() => {
    let triangles = 0
    let vertices = 0
    let meshes = 0
    const materials = new Set<string>()

    model.traverse((obj) => {
      if (!(obj instanceof Mesh))
        return
      meshes++
      const geo = obj.geometry
      vertices += geo.attributes.position?.count ?? 0
      triangles += geo.index
        ? geo.index.count / 3
        : (geo.attributes.position?.count ?? 0) / 3
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material]
      mats.forEach(m => materials.add(m.uuid))
    })

    return [
      { label: 'Triangles', value: fmt(Math.round(triangles)) },
      { label: 'Vertices', value: fmt(vertices) },
      { label: 'Meshes', value: String(meshes) },
      { label: 'Materials', value: String(materials.size) },
    ]
  }, [model])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas)
      return

    const scene = new Scene()

    const clone = skeletonClone(model)
    cloneRef.current = clone

    originalMaterials.current.clear()
    shadeOverrideMaterials.current.forEach(m => m.dispose())
    shadeOverrideMaterials.current.clear()
    flatColors.current.clear()

    scene.add(clone)

    const keyLight = new DirectionalLight(0xFFFFFF, 3)
    keyLight.position.set(5, 5, 5)
    scene.add(keyLight)

    const fillLight = new DirectionalLight(0xFFFFFF, 1.5)
    fillLight.position.set(-5, 2, -5)
    scene.add(fillLight)

    scene.add(new AmbientLight(0xFFFFFF, 0.6))

    const box = new Box3().setFromObject(clone)
    const size = new Vector3()
    const center = new Vector3()
    box.getSize(size)
    box.getCenter(center)

    clone.position.sub(center)

    const maxDim = Math.max(size.x, size.y, size.z)
    const camera = new PerspectiveCamera(50, 1, 0.01, 1000)
    const fov = camera.fov * (Math.PI / 180)
    const dist = maxDim / (2 * Math.tan(fov / 2))
    camera.position.set(0, 0, dist * 1.5)
    camera.near = 0.1
    camera.far = dist + maxDim * 2
    camera.updateProjectionMatrix()
    camera.lookAt(0, 0, 0)

    const renderer = new WebGLRenderer({ canvas, antialias: true })
    renderer.setPixelRatio(Game.instance().sizes.pixelRatio)
    renderer.setClearColor('#181818')

    const controls = new OrbitControls(camera, canvas)
    controls.target.set(0, 0, 0)
    controls.enableDamping = true
    controls.dampingFactor = 0.08
    controls.update()

    const mixer = new AnimationMixer(clone)
    mixerRef.current = mixer

    const onUpdate = (delta: number) => {
      mixer.update(isPlayingRef.current ? delta : 0)
      controls.update()
      renderer.render(scene, camera)
      if (activeActionRef.current && scrubberRef.current)
        scrubberRef.current.value = String(activeActionRef.current.time)
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
      cloneRef.current = null
      mixerRef.current = null
      Game.instance().unregisterOnUpdate(onUpdate)
      observer.disconnect()
      controls.dispose()
      mixer.stopAllAction()
      renderer.dispose()
    }
  }, [model])

  useEffect(() => {
    const mixer = mixerRef.current
    if (!mixer)
      return
    mixer.stopAllAction()
    activeActionRef.current = null
    setAnimDuration(0)
    if (selectedAnim && animations) {
      const clip = animations.find(a => a.name === selectedAnim)
      if (clip) {
        const action = mixer.clipAction(clip)
        action.setLoop(loopAnim ? LoopRepeat : LoopOnce, loopAnim ? Infinity : 1)
        action.clampWhenFinished = !loopAnim
        action.play()
        activeActionRef.current = action
        setAnimDuration(clip.duration)
        isPlayingRef.current = true
        setIsPlaying(true)
        if (scrubberRef.current)
          scrubberRef.current.value = '0'
      }
    }
  }, [selectedAnim, loopAnim, animations])

  useEffect(() => {
    const clone = cloneRef.current
    if (!clone)
      return
    applyShadeMode(clone, shadeMode, originalMaterials.current, shadeOverrideMaterials.current, flatColors.current)
  }, [model, shadeMode])

  return (
    <div className={styles.viewer}>
      <div className={styles.canvasWrapper}>
        <canvas ref={canvasRef} style={{ width: '100%', height: '100%', display: 'block' }} />
        <div className={styles.toolbar}>
          <ShadeModeButtons
            shadeMode={shadeMode}
            onChange={setShadeMode}
            btnClass={canvasStyles.toolBtn}
            activeClass={canvasStyles.active}
            size={16}
          />
        </div>
        {selectedAnim && animDuration > 0 && (
          <input
            ref={scrubberRef}
            type="range"
            min={0}
            max={animDuration}
            step="any"
            defaultValue={0}
            className={styles.scrubber}
            onPointerDown={pause}
            onChange={(e) => {
              const action = activeActionRef.current
              if (!action)
                return
              action.time = Number.parseFloat(e.target.value)
              mixerRef.current?.update(0)
            }}
          />
        )}
        {animations && animations.length > 0 && (
          <div className={styles.animBar}>
            {selectedAnim && (
              <button
                className={canvasStyles.toolBtn}
                onClick={togglePlay}
                title={isPlaying ? 'Pause' : 'Play'}
              >
                {isPlaying
                  ? (
                      <svg width={14} height={14} viewBox="0 0 14 14" fill="currentColor">
                        <rect x="2" y="1" width="4" height="12" rx="1" />
                        <rect x="8" y="1" width="4" height="12" rx="1" />
                      </svg>
                    )
                  : (
                      <svg width={14} height={14} viewBox="0 0 14 14" fill="currentColor">
                        <polygon points="2,1 12,7 2,13" />
                      </svg>
                    )}
              </button>
            )}
            <select
              className={styles.animSelect}
              value={selectedAnim ?? ''}
              onChange={e => setSelectedAnim(e.target.value || null)}
            >
              <option value="">No animation</option>
              {animations.map(a => (
                <option key={a.name} value={a.name}>{a.name}</option>
              ))}
            </select>
            <label className={styles.animLoopLabel}>
              <input
                type="checkbox"
                checked={loopAnim}
                onChange={e => setLoopAnim(e.target.checked)}
              />
              Loop
            </label>
          </div>
        )}
      </div>
      <AssetStats stats={stats} />
    </div>
  )
}
