import type { BrushContext, BrushDefinition, BrushHit, BrushStroke, BrushUndo } from '@mavonengine/core/Brushes/BrushRegistry'
import type { ScatterBrush } from '@mavonengine/core/Scatter/scatterBrush'
import type GameScene from '@mavonengine/core/Scene/GameScene'
import type { Intersection, Object3D } from 'three'
import type Editor from '../../Editor'
import { brushOptionDefaults, getBrush } from '@mavonengine/core/Brushes/BrushRegistry'
import { registerBuiltinBrushes } from '@mavonengine/core/Brushes/builtinBrushes'
import Game from '@mavonengine/core/Game'
import { SCATTER_TYPE } from '@mavonengine/core/Scatter/scatterData'
import ScatterLayer, { SCATTER_MESH_FLAG } from '@mavonengine/core/Scatter/ScatterLayer'
import Terrain from '@mavonengine/core/Terrain/Terrain'
import { TERRAIN_TYPE } from '@mavonengine/core/Terrain/terrainData'
import EventEmitter from '@mavonengine/core/Utils/EventEmitter'
import {
  BufferAttribute,
  BufferGeometry,
  Line,
  LineBasicMaterial,
  Mesh,
  Raycaster,
  Vector2,
  Vector3,
} from 'three'

/*
 * Paints with the brushes of the brush registry (the built-in sculpt, paint and scatter ones and the plugins'): turns
 * the pointer into stamps spaced along the drag, draws the brush ring and keeps the strokes' undo history.
 * Left drag paints, Shift does the opposite, [ and ] resize, Ctrl+Z / Ctrl+Shift+Z undo and redo, Esc puts the brush
 * down.
 */

export interface BrushSettings {
  /** Meters */
  radius: number
  /** 0 – 1 */
  strength: number
  /** 0 – 1 */
  falloff: number
  /** Distance between stamps along a stroke, as a part of the radius */
  spacing: number
  /** Index of the terrain layer the paint brushes paint */
  paintLayer: number
  /** Each brush's own options, by brush key */
  options: Record<string, Record<string, unknown>>
}

const SETTINGS_KEY = 'mavonengine:brush-settings'

const DEFAULTS: BrushSettings = {
  radius: 5,
  strength: 0.5,
  falloff: 0.5,
  spacing: 0.25,
  paintLayer: 0,
  options: {},
}

function loadSettings(): BrushSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) ?? '{}')
    return {
      ...DEFAULTS,
      ...saved,
      options: { ...saved?.options },
    }
  }
  catch {
    return { ...DEFAULTS, options: {} }
  }
}

interface UndoStep extends BrushUndo {
  label: string
}

const MAX_UNDO = 50
const RING_SEGMENTS = 64

export default class BrushTool extends EventEmitter {
  /** Key of the brush in use, or null to select and move objects as usual */
  brush: string | null = null
  settings: BrushSettings = loadSettings()
  /** The scatter brush the asset brushes place */
  scatterBrush?: ScatterBrush
  /** Bumped on every change, for the UI */
  version = 0

  private undoStack: UndoStep[] = []
  private redoStack: UndoStep[] = []
  private stroke?: { definition: BrushDefinition, stroke: BrushStroke, last?: Vector3 }
  private ring: Line
  private innerRing: Line
  private raycaster = new Raycaster()
  private pointer = new Vector2()
  private abort = new AbortController()

  constructor(private readonly editor: Editor) {
    super()
    registerBuiltinBrushes()

    const ringGeometry = () => new BufferGeometry().setAttribute('position', new BufferAttribute(new Float32Array((RING_SEGMENTS + 1) * 3), 3))
    this.ring = new Line(ringGeometry(), new LineBasicMaterial({ color: 0x4A9EFF, depthTest: false, transparent: true }))
    this.innerRing = new Line(ringGeometry(), new LineBasicMaterial({
      color: 0x4A9EFF,
      depthTest: false,
      transparent: true,
      opacity: 0.5,
    }))
    for (const ring of [this.ring, this.innerRing]) {
      ring.userData.isEditorInternal = true
      ring.renderOrder = 999
      ring.visible = false
      ring.frustumCulled = false
      ring.raycast = () => {}
    }
    Game.instance().scene.add(this.ring, this.innerRing)

    const canvas = Game.instance().canvas
    const signal = this.abort.signal
    // Captured, so a stroke starts before the editor selects what was clicked
    canvas.addEventListener('pointerdown', e => this.onPointerDown(e), { signal, capture: true })
    window.addEventListener('pointermove', e => this.onPointerMove(e), { signal })
    window.addEventListener('pointerup', e => this.onPointerUp(e), { signal })
    canvas.addEventListener('pointerleave', () => {
      if (!this.stroke)
        this.setRingVisible(false)
    }, { signal })
    window.addEventListener('keydown', e => this.onKeyDown(e), { signal, capture: true })
  }

  get active(): boolean {
    return this.brush !== null
  }

  get definition(): BrushDefinition | undefined {
    return this.brush
      ? getBrush(this.brush)
      : undefined
  }

  /** Pick up a brush by its key, or put it down with null */
  setBrush(key: string | null): void {
    if (this.stroke)
      this.endStroke()
    this.brush = key && getBrush(key)
      ? key
      : null
    if (this.brush)
      this.editor.deselect()
    this.setRingVisible(false)
    this.changed()
  }

  setSettings(changes: Partial<BrushSettings>): void {
    this.settings = {
      ...this.settings,
      ...changes,
    }
    this.settings.radius = Math.min(500, Math.max(0.1, this.settings.radius))
    this.saveSettings()
    this.changed()
  }

  /** A brush's options, with defaults for those not set */
  options(key: string): Record<string, unknown> {
    const definition = getBrush(key)
    return {
      ...(definition
        ? brushOptionDefaults(definition)
        : {}),
      ...this.settings.options[key],
    }
  }

  setOption(key: string, option: string, value: unknown): void {
    this.settings.options = {
      ...this.settings.options,
      [key]: { ...this.settings.options[key], [option]: value },
    }
    this.saveSettings()
    this.changed()
  }

  private saveSettings(): void {
    try {
      localStorage.setItem(SETTINGS_KEY, JSON.stringify(this.settings))
    }
    catch {
      // Private mode: the settings last until reload
    }
  }

  setScatterBrush(brush: ScatterBrush | undefined): void {
    this.scatterBrush = brush
    this.changed()
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0
  }

  get canRedo(): boolean {
    return this.redoStack.length > 0
  }

  undo(): void {
    const step = this.undoStack.pop()
    if (!step)
      return
    step.undo()
    this.redoStack.push(step)
    this.sceneChanged()
    this.changed()
  }

  redo(): void {
    const step = this.redoStack.pop()
    if (!step)
      return
    step.redo()
    this.undoStack.push(step)
    this.sceneChanged()
    this.changed()
  }

  /** Add a change made outside a stroke (e.g. Fill) to the history */
  pushUndo(label: string, step: BrushUndo): void {
    this.undoStack.push({ label, ...step })
    if (this.undoStack.length > MAX_UNDO)
      this.undoStack.shift()
    this.redoStack = []
    this.sceneChanged()
    this.changed()
  }

  /** Forget the history, e.g. after opening another scene */
  clearHistory(): void {
    this.undoStack = []
    this.redoStack = []
    this.changed()
  }

  private changed(): void {
    this.version++
    this.trigger('changed')
  }

  private get scene(): GameScene | undefined {
    return Game.instance().activeScene
  }

  // --- Scene objects the brushes work on ---

  terrains(): Terrain[] {
    return (this.scene?.getEntries() ?? [])
      .map(entry => entry.object)
      .filter((o): o is Terrain => o instanceof Terrain)
  }

  /** The terrain the panel edits: the selected one, else the first */
  terrain(): Terrain | undefined {
    const selected = this.editor.activeItem
      ? this.scene?.entryOfObject3D(this.editor.activeItem)?.object
      : undefined
    return selected instanceof Terrain
      ? selected
      : this.terrains()[0]
  }

  /** The scene's scatter layer, made on first use when `create` */
  scatterLayer(create = false): ScatterLayer | undefined {
    const existing = (this.scene?.getEntries() ?? []).map(e => e.object).find((o): o is ScatterLayer => o instanceof ScatterLayer)
    if (existing || !create || !this.scene)
      return existing
    const entry = this.scene.create(SCATTER_TYPE, { name: 'Scatter layer' })
    this.editor.trigger('sceneChanged')
    return entry?.object instanceof ScatterLayer
      ? entry.object
      : undefined
  }

  /** Add a terrain to the scene at the origin */
  createTerrain(): Terrain | undefined {
    const entry = this.scene?.create(TERRAIN_TYPE, { name: 'Terrain' })
    this.editor.trigger('sceneChanged')
    this.changed()
    return entry?.object instanceof Terrain
      ? entry.object
      : undefined
  }

  /** The scene changed through a brush: the editor's dirty marker and explorer follow */
  sceneChanged(): void {
    this.scene?.trigger('changed')
  }

  private context(invert: boolean): BrushContext | undefined {
    const scene = this.scene
    if (!scene || !this.brush)
      return undefined
    const { radius, strength, falloff, paintLayer } = this.settings
    return {
      scene,
      settings: { radius, strength, falloff },
      options: this.options(this.brush),
      invert,
      paintLayer,
      scatterBrush: this.scatterBrush,
      scatterLayer: create => this.scatterLayer(create),
      surfaceBelow: point => this.surfaceBelow(point),
      random: Math.random,
      logger: Game.instance().logger ?? undefined,
    }
  }

  // --- Pointer ---

  private updatePointer(e: PointerEvent): void {
    const rect = Game.instance().canvas.getBoundingClientRect()
    this.pointer.set(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1)
    this.raycaster.setFromCamera(this.pointer, Game.instance().camera.instance)
  }

  /** Meshes a surface brush may paint onto: not editor gizmos, not scattered instances, not terrains (they're marched) */
  private surfaces(): Object3D[] {
    const terrains = new Set<Object3D>(this.terrains().map(t => t.instance))
    const out: Object3D[] = []
    const visit = (o: Object3D) => {
      if (!o.visible || o.userData.isEditorInternal || o.userData[SCATTER_MESH_FLAG] || terrains.has(o))
        return
      if (o instanceof Mesh && o.userData.editorHelper?.mesh !== o)
        out.push(o)
      o.children.forEach(visit)
    }
    Game.instance().scene.children.forEach(visit)
    return out
  }

  /** What a ray meets first: the camera's by default */
  private hit(raycaster = this.raycaster, terrainsOnly = false): BrushHit | undefined {
    let best: BrushHit | undefined
    let bestDistance = Infinity
    for (const terrain of this.terrains()) {
      const hit = terrain.raycast(raycaster.ray)
      if (!hit)
        continue
      const d = hit.point.distanceTo(raycaster.ray.origin)
      if (d < bestDistance) {
        bestDistance = d
        best = { point: hit.point, normal: hit.normal, terrain }
      }
    }
    if (terrainsOnly)
      return best

    const first: Intersection | undefined = raycaster.intersectObjects(this.surfaces(), false)[0]
    if (first && first.distance < bestDistance) {
      const normal = first.face?.normal.clone().transformDirection(first.object.matrixWorld) ?? new Vector3(0, 1, 0)
      best = {
        point: first.point.clone(),
        normal,
        object: first.object,
      }
    }
    return best
  }

  private surfaceBelow(point: Vector3): BrushHit | undefined {
    return this.hit(new Raycaster(point.clone().add(new Vector3(0, 200, 0)), new Vector3(0, -1, 0), 0, 400))
  }

  private brushHit(): BrushHit | undefined {
    return this.hit(this.raycaster, this.definition?.target === 'terrain')
  }

  private onPointerDown(e: PointerEvent): void {
    const definition = this.definition
    if (!definition || e.button !== 0 || e.altKey)
      return
    this.updatePointer(e)
    const hit = this.brushHit()
    // Painting, not selecting, even when the click misses
    e.stopPropagation()
    if (!hit)
      return
    const context = this.context(e.shiftKey)
    const stroke = context && definition.begin(hit, context)
    if (!stroke)
      return
    e.preventDefault()
    this.stroke = { definition, stroke }
    this.editor.cameraControls.enabled = false
    this.stamp(hit, e.shiftKey)
  }

  private onPointerMove(e: PointerEvent): void {
    if (!this.brush)
      return
    if (e.target !== Game.instance().canvas && !this.stroke)
      return
    this.updatePointer(e)
    const hit = this.brushHit()
    this.updateRing(hit)
    const last = this.stroke?.last
    if (!this.stroke || !hit || !last)
      return
    // Stamps along the way, `spacing` of the radius apart
    const step = Math.max(0.05, this.settings.radius * this.settings.spacing)
    const distance = last.distanceTo(hit.point)
    if (distance < step)
      return
    const steps = Math.min(32, Math.floor(distance / step))
    for (let i = 1; i <= steps; i++) {
      this.stamp({
        ...hit,
        point: last.clone().lerp(hit.point, i / steps),
      }, e.shiftKey)
    }
  }

  private onPointerUp(e: PointerEvent): void {
    if (e.button === 0 && this.stroke)
      this.endStroke()
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (!this.brush)
      return
    const target = e.target as HTMLElement | null
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable))
      return
    const mod = e.ctrlKey || e.metaKey
    if (mod && (e.code === 'KeyZ' || e.code === 'KeyY')) {
      e.preventDefault()
      e.stopPropagation()
      if (e.code === 'KeyY' || e.shiftKey)
        this.redo()
      else
        this.undo()
      return
    }
    if (e.code === 'BracketLeft' || e.code === 'BracketRight') {
      const factor = e.code === 'BracketLeft'
        ? 1 / 1.15
        : 1.15
      this.setSettings({ radius: Math.round(this.settings.radius * factor * 100) / 100 })
    }
    if (e.code === 'Escape') {
      e.stopPropagation()
      this.setBrush(null)
    }
  }

  // --- Strokes ---

  private stamp(hit: BrushHit, invert: boolean): void {
    const current = this.stroke
    const context = this.context(invert)
    if (!current || !context)
      return
    current.last = hit.point.clone()
    try {
      current.stroke.stamp(hit, context)
    }
    catch (err) {
      Game.instance().logger?.error(`Brush ${this.brush}: ${(err as Error).message}`)
      this.endStroke()
    }
  }

  private endStroke(): void {
    const current = this.stroke
    this.stroke = undefined
    this.editor.cameraControls.enabled = true
    if (!current)
      return
    const context = this.context(false)
    const undo = ((): BrushUndo | void => {
      try {
        return context && current.stroke.end(context)
      }
      catch (err) {
        Game.instance().logger?.error(`Brush ${this.brush}: ${(err as Error).message}`)
      }
    })()
    if (undo)
      this.pushUndo(current.definition.label ?? current.definition.name, undo)
    else
      this.changed()
  }

  // --- Cursor ---

  private setRingVisible(visible: boolean): void {
    this.ring.visible = visible
    this.innerRing.visible = visible && this.settings.falloff > 0.01 && this.settings.falloff < 0.99
  }

  /** Draw the brush's circle on the ground, following a terrain's heights when it is on one */
  private updateRing(hit: BrushHit | undefined): void {
    if (!hit) {
      this.setRingVisible(false)
      return
    }
    const { radius, falloff } = this.settings
    const u = new Vector3(Math.abs(hit.normal.x) > 0.9
      ? 0
      : 1, 0, Math.abs(hit.normal.x) > 0.9
      ? 1
      : 0).cross(hit.normal).normalize()
    const v = hit.normal.clone().cross(u).normalize()
    const draw = (ring: Line, r: number) => {
      const position = ring.geometry.getAttribute('position') as BufferAttribute
      for (let i = 0; i < RING_SEGMENTS; i++) {
        const a = (i / RING_SEGMENTS) * Math.PI * 2
        const p = hit.point.clone().addScaledVector(u, Math.cos(a) * r).addScaledVector(v, Math.sin(a) * r)
        if (hit.terrain) {
          const local = hit.terrain.toLocal(p)
          local.y = hit.terrain.heightmap.sample(local.x, local.z) + 0.05
          p.copy(hit.terrain.toWorld(local))
        }
        else {
          p.addScaledVector(hit.normal, 0.02)
        }
        position.setXYZ(i, p.x, p.y, p.z)
      }
      // Closed: WebGPU has no LineLoop, so the last point repeats the first
      position.setXYZ(RING_SEGMENTS, position.getX(0), position.getY(0), position.getZ(0))
      position.needsUpdate = true
      ring.geometry.computeBoundingSphere()
    }
    draw(this.ring, radius)
    draw(this.innerRing, radius * (1 - falloff))
    const color = this.definition?.color ?? 0x4A9EFF
    ;(this.ring.material as LineBasicMaterial).color.setHex(color)
    ;(this.innerRing.material as LineBasicMaterial).color.setHex(color)
    this.setRingVisible(true)
  }

  /** Called every frame by the editor */
  update(): void {
    this.stroke?.stroke.frame?.()
  }

  dispose(): void {
    this.abort.abort()
    Game.instance().scene.remove(this.ring, this.innerRing)
    for (const ring of [this.ring, this.innerRing]) {
      ring.geometry.dispose()
      ;(ring.material as LineBasicMaterial).dispose()
    }
  }
}
