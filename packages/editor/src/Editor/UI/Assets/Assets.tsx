import type { DragEvent } from 'react'
import type { CubeTexture, Object3D, Scene } from 'three'
import type { Font, GLTF, SVGResult } from 'three/examples/jsm/Addons.js'
import { useEffect, useRef, useState } from 'react'
import { Mesh, Plane, Texture, Vector2, Vector3 } from 'three'
import Game from '@mavonengine/core/Game'
import { getPreviewMap, spawnParticle } from '@mavonengine/core/Particles/System/ParticlePreviewRegistry'
import Grass from '@mavonengine/core/Prefab/Grass/Grass'
import { LIGHT_REGISTRY } from '@mavonengine/core/Prefab/Lights/index'
import { PRIMITIVE_REGISTRY } from '@mavonengine/core/Prefab/Primitives/index'
import Water from '@mavonengine/core/Prefab/Water/Water'
import WaterManager from '@mavonengine/core/Prefab/Water/WaterManager'
import AssetRenderer from '@mavonengine/core/Renderer/AssetRenderer'
import EditorHelper from '@mavonengine/core/Editor/EditorHelper'
import Window from '../Window'
import styles from './Assets.module.css'
import AudioPlayer from './AudioPlayer'
import ModelViewer from './ModelViewer'
import ParticleViewer from './ParticleViewer'
import TextureViewer, { getTextureUrl } from './TextureViewer'

export default () => {
  const editor = Game.instance().editor!

  const DRAG_MIME = 'application/mavonengine-resource'
  const PREFAB_DRAG_MIME = 'application/mavonengine-prefab'
  const PARTICLE_DRAG_MIME = 'application/mavonengine-particle'
  const PRIMITIVE_DRAG_MIME = 'application/mavonengine-primitive'
  const LIGHT_DRAG_MIME = 'application/mavonengine-light'

  const PRIMITIVES = Object.keys(PRIMITIVE_REGISTRY).map(name => ({ name, label: name }))
  const LIGHTS = Object.keys(LIGHT_REGISTRY).map(name => ({ name, label: name }))

  const PREFABS = [
    { name: 'Water', label: 'Water' },
    { name: 'Grass', label: 'Grass' },
  ] as const

  const PARTICLES = Object.keys(getPreviewMap()).map(name => ({ name, label: name }))

  interface OpenAsset { id: number, title: string, item: GLTF | Texture | CubeTexture | AudioBuffer | SVGResult | Font | { particleName: string } }

  const [activeCategory, setActiveCategory] = useState<typeof editor.activeAssetCategory | 'Prefabs' | 'Particles' | 'Primitives' | 'Lights'>(editor.activeAssetCategory)
  const [openAssets, setOpenAssets] = useState<OpenAsset[]>([])
  const [search, setSearch] = useState('')
  const nextId = useRef(0)

  function onItemDragStart(e: DragEvent, key: string) {
    if (!e.dataTransfer)
      return

    window.Game.logger?.info(`Starting drag: ${key}`)

    e.dataTransfer.setData(DRAG_MIME, key)
    e.dataTransfer.setData('text/plain', key)
    e.dataTransfer.effectAllowed = 'copy'
  }

  function onPrefabDragStart(e: DragEvent, prefabName: string) {
    if (!e.dataTransfer)
      return

    e.dataTransfer.setData(PREFAB_DRAG_MIME, prefabName)
    e.dataTransfer.setData('text/plain', prefabName)
    e.dataTransfer.effectAllowed = 'copy'
  }

  function onParticleDragStart(e: DragEvent, particleName: string) {
    if (!e.dataTransfer)
      return

    e.dataTransfer.setData(PARTICLE_DRAG_MIME, particleName)
    e.dataTransfer.setData('text/plain', particleName)
    e.dataTransfer.effectAllowed = 'copy'
  }

  function onPrimitiveDragStart(e: DragEvent, primitiveName: string) {
    if (!e.dataTransfer)
      return

    e.dataTransfer.setData(PRIMITIVE_DRAG_MIME, primitiveName)
    e.dataTransfer.setData('text/plain', primitiveName)
    e.dataTransfer.effectAllowed = 'copy'
  }

  function onLightDragStart(e: DragEvent, lightName: string) {
    if (!e.dataTransfer)
      return

    e.dataTransfer.setData(LIGHT_DRAG_MIME, lightName)
    e.dataTransfer.setData('text/plain', lightName)
    e.dataTransfer.effectAllowed = 'copy'
  }

  function onEditorDragOver(e: globalThis.DragEvent) {
    if (!e.dataTransfer)
      return

    const hasPayload
      = e.dataTransfer.types?.includes(DRAG_MIME)
        || e.dataTransfer.types?.includes(PREFAB_DRAG_MIME)
        || e.dataTransfer.types?.includes(PARTICLE_DRAG_MIME)
        || e.dataTransfer.types?.includes(PRIMITIVE_DRAG_MIME)
        || e.dataTransfer.types?.includes(LIGHT_DRAG_MIME)
        || e.dataTransfer.types?.includes('text/plain')

    if (hasPayload) {
      e.preventDefault()
      e.dataTransfer.dropEffect = 'copy'
    }

    window.Game.logger?.info(`Dragging asset over canvas: ${e.dataTransfer.getData('text/plain')}`)
  }

  function onEditorDrop(e: globalThis.DragEvent) {
    if (!e.dataTransfer)
      return
    e.preventDefault()

    const prefabName = e.dataTransfer.getData(PREFAB_DRAG_MIME)
    if (prefabName) {
      const canvas = window.Game.canvas
      const rect = canvas.getBoundingClientRect()
      const coords = new Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      window.Game.rayCaster.setFromCamera(coords, window.Game.camera.instance)
      const groundPlane = new Plane(new Vector3(0, 1, 0), 0)
      const dropPos = new Vector3()
      window.Game.rayCaster.ray.intersectPlane(groundPlane, dropPos)

      if (prefabName === 'Water') {
        const isFirst = !WaterManager.instance
        if (isFirst) {
          WaterManager.init()
        }
        const water = new Water(dropPos, 20)
        WaterManager.instance!.waters.push(water)
        window.Game.world.add({ [`prefab_water_${Date.now()}`]: water })
        if (isFirst)
          window.Game.editor?.trigger('prefabCreated', { label: 'Water', addBindings: WaterManager.instance!.addBindings.bind(WaterManager.instance!) })
        window.Game.editor?.trigger('assetDropped')
        window.Game.logger?.info(`Spawned Water prefab at ${dropPos.toArray()}`)
      }
      else if (prefabName === 'Grass') {
        const grassGltfs = Object.entries(window.Game.resources.items)
          .filter(([k, v]) => 'scene' in v && k.toLowerCase().includes('grass'))
        if (grassGltfs.length >= 2) {
          const grass = new Grass(grassGltfs[0][1] as GLTF, grassGltfs[1][1] as GLTF, 10000, 12.5, dropPos)
          window.Game.world.add({ [`prefab_grass_${Date.now()}`]: grass })
          window.Game.editor?.trigger('prefabPanesCleared')
          window.Game.editor?.trigger('prefabCreated', { label: 'Grass', addBindings: grass.addBindings.bind(grass) })
          window.Game.editor?.trigger('assetDropped')
          window.Game.logger?.info(`Spawned Grass prefab at ${dropPos.toArray()}`)
        }
        else {
          window.Game.logger?.warn('Grass prefab requires two GLTF resources with "grass" in their name')
        }
      }
      return
    }

    const particleName = e.dataTransfer.getData(PARTICLE_DRAG_MIME)
    if (particleName) {
      const canvas = window.Game.canvas
      const rect = canvas.getBoundingClientRect()
      const coords = new Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      window.Game.rayCaster.setFromCamera(coords, window.Game.camera.instance)
      const groundPlane = new Plane(new Vector3(0, 1, 0), 0)
      const dropPos = new Vector3()
      window.Game.rayCaster.ray.intersectPlane(groundPlane, dropPos)

      const effect = spawnParticle(particleName, dropPos)
      if (effect) {
        window.Game.world.add({ [`particle_${particleName.toLowerCase()}_${Date.now()}`]: effect })
        window.Game.editor?.trigger('assetDropped')
        window.Game.logger?.info(`Spawned ${particleName} particle effect at ${dropPos.toArray()}`)
      }
      return
    }

    const primitiveName = e.dataTransfer.getData(PRIMITIVE_DRAG_MIME)
    if (primitiveName) {
      const PrimitiveClass = PRIMITIVE_REGISTRY[primitiveName]
      if (PrimitiveClass) {
        const canvas = window.Game.canvas
        const rect = canvas.getBoundingClientRect()
        const coords = new Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        )
        window.Game.rayCaster.setFromCamera(coords, window.Game.camera.instance)
        const groundPlane = new Plane(new Vector3(0, 1, 0), 0)
        const dropPos = new Vector3()
        window.Game.rayCaster.ray.intersectPlane(groundPlane, dropPos)

        const primitive = new PrimitiveClass(dropPos)
        window.Game.world.add({ [`primitive_${primitiveName.toLowerCase()}_${Date.now()}`]: primitive })
        window.Game.editor?.trigger('assetDropped')
        window.Game.logger?.info(`Spawned ${primitiveName} primitive at ${dropPos.toArray()}`)
      }
      return
    }

    const lightName = e.dataTransfer.getData(LIGHT_DRAG_MIME)
    if (lightName) {
      const LightClass = LIGHT_REGISTRY[lightName]
      if (LightClass) {
        const canvas = window.Game.canvas
        const rect = canvas.getBoundingClientRect()
        const coords = new Vector2(
          ((e.clientX - rect.left) / rect.width) * 2 - 1,
          -((e.clientY - rect.top) / rect.height) * 2 + 1,
        )
        window.Game.rayCaster.setFromCamera(coords, window.Game.camera.instance)
        const groundPlane = new Plane(new Vector3(0, 1, 0), 0)
        const dropPos = new Vector3()
        window.Game.rayCaster.ray.intersectPlane(groundPlane, dropPos)

        const light = new LightClass(dropPos)
        window.Game.world.add({ [`light_${lightName.toLowerCase()}_${Date.now()}`]: light })
        window.Game.editor?.trigger('assetDropped')
        window.Game.logger?.info(`Spawned ${lightName} at ${dropPos.toArray()}`)
      }
      return
    }

    const key
      = e.dataTransfer.getData(DRAG_MIME)
        || e.dataTransfer.getData('text/plain')

    if (!key)
      return

    const item = window.Game.resources.items[key]
    if (!item)
      return

    if (item instanceof Texture) {
      const canvas = window.Game.canvas
      const rect = canvas.getBoundingClientRect()
      const coords = new Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      window.Game.rayCaster.setFromCamera(coords, window.Game.camera.instance)
      const intersects = window.Game.rayCaster.intersectObjects(window.Game.scene.children, true)
      const hit = intersects.find(i => i.object instanceof Mesh)
      if (hit && hit.object instanceof Mesh) {
        const mesh = hit.object
        const material = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material
        if (material && 'map' in material) {
          (material as { map: Texture | null, needsUpdate: boolean }).map = item
          material.needsUpdate = true
        }
      }
      window.Game.logger?.info(`Dropped texture: ${key}`)
      return
    }

    const scene = 'scene' in item ? item.scene as unknown as Scene : null
    if (scene) {
      window.Game.scene.add(scene.clone())
      window.Game.editor?.trigger('assetDropped')
    }

    window.Game.logger?.info(`Dropped asset: ${key}`)
  }

  useEffect(() => {
    function onCanvasMouseDown() {
      (document.activeElement as HTMLElement)?.blur()
    }

    function onObjectSelected(obj: Object3D) {
      window.Game.editor?.trigger('prefabPanesCleared')

      const helper = EditorHelper.from(obj)
      if (helper?.attachment?.addBindings) {
        window.Game.editor?.trigger('prefabCreated', {
          label: helper.labelText,
          addBindings: helper.attachment.addBindings.bind(helper.attachment),
        })
        return
      }

      const mat = obj instanceof Mesh ? (Array.isArray(obj.material) ? obj.material[0] : obj.material) : null

      if (mat && WaterManager.instance?.waters.some(w => w.material === mat)) {
        window.Game.editor?.trigger('prefabCreated', {
          label: 'Water',
          addBindings: WaterManager.instance!.addBindings.bind(WaterManager.instance!),
        })
      }

      const grassInstance = obj.userData.grassInstance
      if (grassInstance instanceof Grass) {
        window.Game.editor?.trigger('prefabCreated', {
          label: 'Grass',
          addBindings: grassInstance.addBindings.bind(grassInstance),
        })
      }
    }

    window.Game.canvas.addEventListener('dragover', onEditorDragOver)
    window.Game.canvas.addEventListener('drop', onEditorDrop)
    window.Game.canvas.addEventListener('mousedown', onCanvasMouseDown)
    window.Game.editor?.on('objectSelected', onObjectSelected)

    return () => {
      window.Game.canvas.removeEventListener('dragover', onEditorDragOver)
      window.Game.canvas.removeEventListener('drop', onEditorDrop)
      window.Game.canvas.removeEventListener('mousedown', onCanvasMouseDown)
      window.Game.editor?.off('objectSelected', onObjectSelected)
    }
  }, [])

  const filteredItems = Object.entries(window.Game.resources.items)
    .filter(([_, item]) => item.constructor.name === activeCategory)
    .filter(([key]) => key.toLowerCase().includes(search.toLowerCase()))

  function getAssetTitle(key: string): string {
    const source = window.Game.resources.sources.find(s => s.name === key)
    if (!source)
      return key
    const path = Array.isArray(source.path) ? source.path[0] : source.path
    return path.split('/').pop() ?? key
  }

  function openAsset(name: string, item: OpenAsset['item']) {
    const id = nextId.current++
    const title = getAssetTitle(name)
    setOpenAssets(prev => [...prev, { id, title, item }])
  }

  function closeAsset(id: number) {
    setOpenAssets(prev => prev.filter(a => a.id !== id))
  }

  return (
    <>
      {openAssets.map(({ id, title, item }) => {
        const offset = (id % 6) * 24
        return (
          <Window
            key={id}
            title={title}
            defaultX={(window.innerWidth - 400) / 2 + offset}
            defaultY={(window.innerHeight - 300) / 2 + offset}
            storageKey={item instanceof AudioBuffer ? 'audioViewer' : 'scene' in item ? 'modelViewer' : item instanceof Texture ? 'textureViewer' : 'particleName' in item ? 'particleViewer' : undefined}
            onClose={() => closeAsset(id)}
          >
            {item instanceof AudioBuffer && <AudioPlayer buffer={item} />}
            {'scene' in item && <ModelViewer model={item.scene} animations={(item as GLTF).animations} />}
            {item instanceof Texture && <TextureViewer texture={item} />}
            {'particleName' in item && <ParticleViewer particleName={item.particleName} />}
          </Window>
        )
      })}
      <div className={styles.assetsPanel}>
        <div className={styles.toolbar}>
          <div className={styles.searchWrapper}>
            <input
              className={styles.search}
              type="text"
              placeholder="Search..."
              value={search}
              onChange={e => setSearch(e.target.value)}
              onKeyDown={e => e.stopPropagation()}
              onKeyUp={e => e.stopPropagation()}
            />
            {search && (
              <button className={styles.searchClear} onClick={() => setSearch('')}>✕</button>
            )}
          </div>
          <select
            className={styles.categorySelect}
            value={activeCategory}
            onChange={(e) => {
              const val = e.target.value as typeof activeCategory
              if (val !== 'Prefabs' && val !== 'Particles' && val !== 'Primitives' && val !== 'Lights') {
                editor.setActiveAssetCategory(val as typeof editor.activeAssetCategory)
              }
              setActiveCategory(val)
            }}
          >
            {editor.availableAssetCategories.map(item => (
              <option key={item} value={item}>{item}</option>
            ))}
            <option value="Prefabs">Prefabs</option>
            <option value="Particles">Particles</option>
            <option value="Primitives">Primitives</option>
            <option value="Lights">Lights</option>
          </select>
        </div>
        <div className={styles.assets}>
          {activeCategory === 'Lights'
            ? LIGHTS
                .filter(l => l.label.toLowerCase().includes(search.toLowerCase()))
                .map(light => (
                  <div className={styles.assetRow} key={light.name}>
                    <div
                      className={styles.assetIcon}
                      onDragStart={e => onLightDragStart(e, light.name)}
                      draggable
                    >
                      <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <circle cx="32" cy="28" r="10" stroke="#FFD700" strokeWidth="2" fill="none" />
                        <line x1="32" y1="8" x2="32" y2="14" stroke="#FFD700" strokeWidth="2" strokeLinecap="round" />
                        <line x1="32" y1="42" x2="32" y2="48" stroke="#FFD700" strokeWidth="2" strokeLinecap="round" />
                        <line x1="12" y1="28" x2="18" y2="28" stroke="#FFD700" strokeWidth="2" strokeLinecap="round" />
                        <line x1="46" y1="28" x2="52" y2="28" stroke="#FFD700" strokeWidth="2" strokeLinecap="round" />
                        <line x1="17" y1="13" x2="21" y2="17" stroke="#FFD700" strokeWidth="2" strokeLinecap="round" />
                        <line x1="43" y1="39" x2="47" y2="43" stroke="#FFD700" strokeWidth="2" strokeLinecap="round" />
                        <line x1="47" y1="13" x2="43" y2="17" stroke="#FFD700" strokeWidth="2" strokeLinecap="round" />
                        <line x1="21" y1="39" x2="17" y2="43" stroke="#FFD700" strokeWidth="2" strokeLinecap="round" />
                        <line x1="28" y1="50" x2="36" y2="50" stroke="#FFD700" strokeWidth="2" strokeLinecap="round" />
                        <line x1="29" y1="54" x2="35" y2="54" stroke="#FFD700" strokeWidth="1.5" strokeLinecap="round" opacity="0.6" />
                      </svg>
                    </div>
                    {light.label}
                  </div>
                ))
            : activeCategory === 'Primitives'
              ? PRIMITIVES
                  .filter(p => p.label.toLowerCase().includes(search.toLowerCase()))
                  .map(primitive => (
                    <div className={styles.assetRow} key={primitive.name}>
                      <div
                        className={styles.assetIcon}
                        onDragStart={e => onPrimitiveDragStart(e, primitive.name)}
                        draggable
                      >
                        <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                          <path d="M16 40 L16 24 L32 16 L48 24 L48 40 L32 48 Z" stroke="#4a9eff" strokeWidth="2" fill="none" />
                          <path d="M16 24 L32 32 M48 24 L32 32 M32 48 L32 32" stroke="#4a9eff" strokeWidth="1.5" fill="none" opacity="0.5" />
                        </svg>
                      </div>
                      {primitive.label}
                    </div>
                  ))
              : activeCategory === 'Particles'
                ? PARTICLES
                    .filter(p => p.label.toLowerCase().includes(search.toLowerCase()))
                    .map(particle => (
                      <div className={styles.assetRow} key={particle.name}>
                        <div
                          className={styles.assetIcon}
                          onDragStart={e => onParticleDragStart(e, particle.name)}
                          onDoubleClick={() => openAsset(particle.name, { particleName: particle.name })}
                          draggable
                        >
                          {particle.name === 'Rain'
                            ? (
                                <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                                  <path d="M16 10 Q20 6 28 8 Q30 2 38 4 Q46 2 48 10 Q56 10 56 20 Q56 28 46 28 L18 28 Q8 28 8 20 Q8 12 16 10Z" fill="#5a7fa8" opacity="0.6" />
                                  <line x1="20" y1="34" x2="16" y2="46" stroke="#4a9eff" strokeWidth="2" strokeLinecap="round" opacity="0.9" />
                                  <line x1="32" y1="34" x2="28" y2="50" stroke="#4a9eff" strokeWidth="2" strokeLinecap="round" opacity="0.9" />
                                  <line x1="44" y1="34" x2="40" y2="46" stroke="#4a9eff" strokeWidth="2" strokeLinecap="round" opacity="0.9" />
                                  <line x1="26" y1="38" x2="22" y2="54" stroke="#4a9eff" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
                                  <line x1="38" y1="38" x2="34" y2="54" stroke="#4a9eff" strokeWidth="2" strokeLinecap="round" opacity="0.6" />
                                </svg>
                              )
                            : (
                                <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                                  <path d="M28 54 Q24 44 26 34 Q20 38 16 34 Q18 24 28 22 Q26 16 32 12 Q38 16 36 22 Q46 24 48 34 Q44 38 38 34 Q40 44 36 54 Z" fill="#888888" opacity="0.5" />
                                  <path d="M28 54 Q22 46 24 36 Q18 40 14 36 Q15 26 26 24" fill="#aaaaaa" opacity="0.3" />
                                  <circle cx="32" cy="36" r="3" fill="#cccccc" opacity="0.4" />
                                </svg>
                              )}
                        </div>
                        {particle.label}
                      </div>
                    ))
                : activeCategory === 'Prefabs'
                  ? PREFABS
                      .filter(p => p.label.toLowerCase().includes(search.toLowerCase()))
                      .map(prefab => (
                        <div className={styles.assetRow} key={prefab.name}>
                          <div
                            className={styles.assetIcon}
                            onDragStart={e => onPrefabDragStart(e, prefab.name)}
                            draggable
                          >
                            {prefab.name === 'Water'
                              ? (
                                  <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M8 22 Q16 14 24 22 Q32 30 40 22 Q48 14 56 22" stroke="#4a9eff" strokeWidth="3" fill="none" strokeLinecap="round" />
                                    <path d="M8 34 Q16 26 24 34 Q32 42 40 34 Q48 26 56 34" stroke="#4a9eff" strokeWidth="3" fill="none" strokeLinecap="round" opacity="0.7" />
                                    <path d="M8 46 Q16 38 24 46 Q32 54 40 46 Q48 38 56 46" stroke="#4a9eff" strokeWidth="3" fill="none" strokeLinecap="round" opacity="0.4" />
                                  </svg>
                                )
                              : (
                                  <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                                    <path d="M32 54 Q30 42 26 24" stroke="#4caf50" strokeWidth="3" strokeLinecap="round" />
                                    <path d="M32 54 Q34 40 40 20" stroke="#4caf50" strokeWidth="3" strokeLinecap="round" />
                                    <path d="M32 54 Q22 44 14 30" stroke="#4caf50" strokeWidth="3" strokeLinecap="round" opacity="0.75" />
                                    <path d="M32 54 Q44 46 50 30" stroke="#4caf50" strokeWidth="3" strokeLinecap="round" opacity="0.75" />
                                    <line x1="8" y1="54" x2="56" y2="54" stroke="#4caf50" strokeWidth="2" opacity="0.4" />
                                  </svg>
                                )}
                          </div>
                          {prefab.label}
                        </div>
                      ))
                  : filteredItems.map(([key, item]) => (
                      <div className={styles.assetRow} key={key}>
                        {item instanceof AudioBuffer
                          ? (
                              <div
                                className={styles.assetIcon}
                                onDoubleClick={() => openAsset(key, item)}
                                onDragStart={e => onItemDragStart(e, key)}
                                draggable
                              >
                                <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                                  <rect x="10" y="22" width="12" height="20" rx="2" fill="#4a9eff" />
                                  <path d="M22 28 L42 18 L42 46 L22 36 Z" fill="#4a9eff" />
                                  <path d="M46 24 Q54 32 46 40" stroke="#4a9eff" strokeWidth="3" strokeLinecap="round" fill="none" />
                                  <path d="M50 19 Q62 32 50 45" stroke="#4a9eff" strokeWidth="3" strokeLinecap="round" fill="none" opacity="0.5" />
                                </svg>
                              </div>
                            )
                          : item instanceof Texture
                            ? (
                                <img
                                  className={styles.texturePreview}
                                  onDoubleClick={() => openAsset(key, item)}
                                  onDragStart={e => onItemDragStart(e, key)}
                                  draggable
                                  src={getTextureUrl(item)}
                                />
                              )
                            : (
                                <img
                                  onDoubleClick={() => openAsset(key, item)}
                                  onDragStart={e => onItemDragStart(e, key)}
                                  src={(new AssetRenderer(key).render())}
                                />
                              )}
                        {key}
                      </div>
                    ))}
        </div>
      </div>
    </>
  )
}
