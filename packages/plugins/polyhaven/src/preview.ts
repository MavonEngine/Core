import type { Material, Object3D } from 'three'
import type { ImportedAsset } from './shared'
import {
  AmbientLight,
  Box3,
  BoxGeometry,
  DirectionalLight,
  Mesh,
  PerspectiveCamera,
  PlaneGeometry,
  Scene,
  SphereGeometry,
  Vector3,
} from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import { WebGPURenderer } from 'three/webgpu'

/*
 * A floating window with its own canvas showing an import: a model as it is, a texture's material graph on a shape.
 * Drag to orbit, scroll to zoom, right-drag to pan. Plain DOM and its own renderer, on the game's backend.
 */

export interface PreviewSources {
  /** Whether the game renders with WebGPU, so the preview uses the same backend */
  webgpu: boolean
  /** The loaded glTF scene of a model */
  model(entry: ImportedAsset): Object3D | undefined
  /** The compiled material of a texture's graph */
  material(entry: ImportedAsset): Promise<Material>
}

type Shape = 'sphere' | 'cube' | 'plane'

const STYLE = `
.ph-preview { position: fixed; z-index: 1000; display: flex; flex-direction: column; width: 420px; height: 360px; min-width: 220px; min-height: 180px; resize: both; overflow: hidden; background: var(--bg-panel, #2a2a2a); border: 1px solid var(--border-active, #555); border-radius: 4px; box-shadow: 0 8px 24px rgba(0,0,0,.5); font-family: var(--font-ui); font-size: var(--font-size-sm, 11px); color: var(--text-primary, #e0e0e0); }
.ph-preview-header { display: flex; align-items: center; gap: 8px; padding: 4px 4px 4px 8px; background: var(--bg-header, #1a1a1a); cursor: move; user-select: none; flex-shrink: 0; }
.ph-preview-title { flex: 1; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ph-preview-header button, .ph-preview-header select { background: var(--bg-input, #1e1e1e); border: 1px solid var(--border-primary, #333); border-radius: 2px; color: inherit; font: inherit; cursor: pointer; }
.ph-preview-header button { width: 20px; height: 20px; padding: 0; }
.ph-preview-body { position: relative; flex: 1; min-height: 0; }
.ph-preview canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.ph-preview-hint { position: absolute; left: 8px; bottom: 6px; color: var(--text-muted, #666); pointer-events: none; }
`

let opened = 0

function element<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const el = Object.assign(document.createElement(tag), props)
  el.append(...children)
  return el
}

/** Move `win` by dragging `handle`, keeping it on screen */
function draggable(win: HTMLElement, handle: HTMLElement) {
  handle.addEventListener('pointerdown', (e) => {
    if ((e.target as HTMLElement).closest('button, select'))
      return
    const startX = e.clientX - win.offsetLeft
    const startY = e.clientY - win.offsetTop
    handle.setPointerCapture(e.pointerId)
    const move = (m: PointerEvent) => {
      win.style.left = `${Math.min(Math.max(0, m.clientX - startX), window.innerWidth - 60)}px`
      win.style.top = `${Math.min(Math.max(0, m.clientY - startY), window.innerHeight - 30)}px`
    }
    const up = () => {
      handle.removeEventListener('pointermove', move)
      handle.removeEventListener('pointerup', up)
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', up)
  })
}

/** Point `camera` and `controls` at `object` from a little above, far enough to see all of it */
function frame(object: Object3D, camera: PerspectiveCamera, controls: OrbitControls) {
  const box = new Box3().setFromObject(object)
  const size = box.getSize(new Vector3()).length() || 1
  const center = box.getCenter(new Vector3())
  camera.near = size / 100
  camera.far = size * 100
  camera.position.copy(center).add(new Vector3(0.6, 0.45, 1).normalize().multiplyScalar(size * 1.1))
  camera.updateProjectionMatrix()
  controls.target.copy(center)
  controls.minDistance = size * 0.05
  controls.maxDistance = size * 20
  controls.update()
}

/** Open a preview window of `entry`. Returns a function that closes it */
export function openPreview(entry: ImportedAsset, sources: PreviewSources): () => void {
  const offset = (opened++ % 6) * 24
  const close = element('button', { type: 'button', textContent: '✕', title: 'Close' })
  const shapeSelect = element('select', { title: 'Shape' }, (['sphere', 'cube', 'plane'] as Shape[]).map(shape => element('option', { value: shape, textContent: shape })))
  const header = element('div', { className: 'ph-preview-header' }, [
    element('span', { className: 'ph-preview-title', textContent: `${entry.name} (${entry.resolution})` }),
    ...(entry.kind === 'textures'
      ? [shapeSelect]
      : []),
    close,
  ])
  const canvas = element('canvas')
  const hint = element('span', { className: 'ph-preview-hint', textContent: 'Drag to orbit · scroll to zoom · right-drag to pan' })
  const win = element('div', { className: 'ph-preview' }, [
    element('style', { textContent: STYLE }),
    header,
    element('div', { className: 'ph-preview-body' }, [canvas, hint]),
  ])
  win.style.left = `${Math.max(0, (window.innerWidth - 420) / 2 + offset)}px`
  win.style.top = `${Math.max(0, (window.innerHeight - 360) / 2 + offset)}px`
  // Keys pressed in it don't reach the editor's shortcuts
  win.addEventListener('keydown', e => e.stopPropagation())
  document.body.append(win)
  draggable(win, header)

  const scene = new Scene()
  scene.add(new AmbientLight(0xFFFFFF, 0.6))
  const key = new DirectionalLight(0xFFFFFF, 2.5)
  key.position.set(3, 4, 5)
  const rim = new DirectionalLight(0x9DC4FF, 1)
  rim.position.set(-4, 1, -3)
  scene.add(key, rim)

  const camera = new PerspectiveCamera(40, 1, 0.01, 100)
  const controls = new OrbitControls(camera, canvas)
  controls.enableDamping = true

  const renderer = new WebGPURenderer({
    canvas,
    antialias: true,
    alpha: true,
    forceWebGL: !sources.webgpu,
  })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))

  const geometries: Record<Shape, () => BoxGeometry | SphereGeometry | PlaneGeometry> = {
    sphere: () => new SphereGeometry(1, 96, 48),
    cube: () => new BoxGeometry(1.5, 1.5, 1.5),
    plane: () => new PlaneGeometry(2.5, 2.5).rotateX(-Math.PI / 2),
  }
  let shown: Object3D | undefined
  let closed = false

  if (entry.kind === 'models') {
    const model = sources.model(entry)
    if (model) {
      // A copy: the resource's own scene stays as the game has it
      shown = model.clone(true)
      scene.add(shown)
      frame(shown, camera, controls)
    }
    else {
      hint.textContent = `${entry.name} isn't loaded yet`
    }
  }
  else {
    const mesh = new Mesh(geometries.sphere())
    shown = mesh
    scene.add(mesh)
    frame(mesh, camera, controls)
    sources.material(entry).then((material) => {
      if (!closed)
        mesh.material = material
    }).catch((err: Error) => {
      hint.textContent = `Could not build ${entry.graph}: ${err.message}`
    })
    shapeSelect.addEventListener('change', () => {
      mesh.geometry.dispose()
      mesh.geometry = geometries[shapeSelect.value as Shape]()
      frame(mesh, camera, controls)
    })
  }

  void renderer.init().then(() => {
    if (closed)
      return
    void renderer.setAnimationLoop(() => {
      controls.update()
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

  const dispose = () => {
    if (closed)
      return
    closed = true
    observer.disconnect()
    controls.dispose()
    void renderer.setAnimationLoop(null)
    // The material is the graph's, shared with the game: only the preview's own geometry goes
    if (shown instanceof Mesh)
      shown.geometry.dispose()
    renderer.dispose()
    win.remove()
  }
  close.addEventListener('click', dispose)
  return dispose
}
