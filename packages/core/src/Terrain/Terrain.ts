import type { Material, Quaternion, Ray } from 'three'
import type { PropertyField } from '../Editor/EditorHelper'
import type { SceneObjectData } from '../Scene/types'
import type { GridRegion, TerrainLayer, TerrainProps } from './terrainData'
import type { TerrainMaterialUniforms } from './terrainMaterial'
import {
  DataTexture,
  LinearFilter,
  Matrix4,
  Mesh,
  NoColorSpace,
  RGBAFormat,
  UnsignedByteType,
  Vector3,
} from 'three'
import { WithEditorHelper } from '../Editor/WithEditorHelper'
import Game from '../Game'
import { materialGraphs } from '../Graph/Material/MaterialGraphs'
import GameObject from '../World/GameObject'
import { MAX_SPLAT_LAYERS, SplatMap } from './splatMap'
import { TerrainCollider } from './TerrainCollider'
import {
  buildTerrainGeometry,
  Heightmap,
  MAX_SPLAT_RESOLUTION,
  splatResolutionFor,
  terrainPropsFrom,
  updateTerrainGeometry,
} from './terrainData'
import { buildTerrainMaterial } from './terrainMaterial'

export interface TerrainHit {
  /** World position */
  point: Vector3
  /** World normal */
  normal: Vector3
  /** Terrain local position */
  local: Vector3
}

const HEIGHT_RESOLUTIONS = [65, 129, 257, 513, 1025]
const SPLAT_RESOLUTIONS = [256, 512, 1024, 2048, 4096]

/**
 * A terrain on the client: a heightmap mesh drawn with its layers' material graphs, mixed by splatmaps. The editor's
 * brushes sculpt its heights and paint its splatmaps; call `commit()` after a stroke so the collider and the saved
 * data catch up.
 */
export default class Terrain extends WithEditorHelper(GameObject) {
  instance: Mesh
  heightmap: Heightmap
  splat: SplatMap
  /** One per splatmap, what the material samples */
  splatTextures: DataTexture[] = []
  collider?: TerrainCollider

  private _size: number
  private _splatResolution: number
  private _layers: TerrainLayer[]
  private _collision: boolean
  private uniforms: TerrainMaterialUniforms
  /** What the heights and splatmaps encode to, kept until they change since encoding a splatmap takes a while */
  private encoded: { heights?: string | null, splat?: string[] } = {}
  private materialVersion = 0
  private unsubscribeGraphs?: () => void
  private colliderState?: { position: Vector3, quaternion: Quaternion, scale: Vector3, version: number }
  private heightsVersion = 0
  /** Painted, or loaded painted: until then the splatmap is all first layer and isn't saved */
  private painted = false

  constructor(data: SceneObjectData) {
    const props = terrainPropsFrom(data.props)
    const position = new Vector3(...data.transform.position)
    super(undefined, position)

    this._size = props.size
    this._splatResolution = props.splatResolution
    this._layers = props.layers
    this._collision = props.collision
    this.uniforms = {
      blendSharpness: { value: props.blendSharpness },
    }
    this.heightmap = Heightmap.fromProps(props)
    this.splat = SplatMap.fromProps(props.splatResolution, Math.max(1, props.layers.length), props.splat)
    if (props.heights)
      this.encoded.heights = props.heights
    if (props.splat) {
      this.encoded.splat = props.splat
      this.painted = true
    }

    this.instance = new Mesh(buildTerrainGeometry(this.heightmap))
    this.instance.castShadow = props.castShadow
    this.instance.receiveShadow = props.receiveShadow
    this.instance.position.copy(position)
    // Builds the material too
    this.syncSplatTextures()
    Game.instance().scene.add(this.instance)

    // The editor changing one of the layers' graphs
    this.unsubscribeGraphs = materialGraphs.subscribe(() => void this.rebuildMaterial())

    this.registerEditorHelper(position, 'Terrain', {
      onMove: delta => this.instance.position.add(delta),
      properties: this.properties(),
    })
    this.tagWithHelper(this.instance)
  }

  get size(): number {
    return this._size
  }

  get layers(): TerrainLayer[] {
    return this._layers.map(layer => ({ ...layer }))
  }

  get blendSharpness(): number {
    return this.uniforms.blendSharpness.value
  }

  set blendSharpness(value: number) {
    this.uniforms.blendSharpness.value = Math.min(1, Math.max(0, value))
  }

  get collision(): boolean {
    return this._collision
  }

  setCollision(collision: boolean): void {
    this._collision = collision
    this.syncCollider()
  }

  get splatResolution(): number {
    return this._splatResolution
  }

  /** The props to save */
  sceneProps(): Record<string, unknown> {
    if (this.encoded.heights === undefined)
      this.encoded.heights = this.heightmap.encode() ?? null
    if (!this.encoded.splat)
      this.encoded.splat = this.splat.encode()
    const props: TerrainProps = {
      size: this._size,
      resolution: this.heightmap.resolution,
      splatResolution: this._splatResolution,
      layers: this.layers,
      blendSharpness: Math.round(this.blendSharpness * 1000) / 1000,
      collision: this._collision,
      castShadow: this.instance.castShadow,
      receiveShadow: this.instance.receiveShadow,
      ...(this.encoded.heights
        ? { heights: this.encoded.heights }
        : {}),
      ...(this.painted
        ? { splat: this.encoded.splat }
        : {}),
    }
    return props as unknown as Record<string, unknown>
  }

  // --- Layers ---

  addLayer(graph: string, tiling = 20): boolean {
    if (this._layers.length >= MAX_SPLAT_LAYERS)
      return false
    this._layers = [
      ...this._layers,
      { graph, tiling },
    ]
    this.splat = this.splat.withLayers(this._layers.length)
    this.splatChanged()
    void this.rebuildMaterial()
    return true
  }

  removeLayer(index: number): void {
    if (index < 0 || index >= this._layers.length)
      return
    this.splat.removeLayer(index, this._layers.length)
    this._layers = this._layers.filter((_, i) => i !== index)
    this.splat = this.splat.withLayers(Math.max(1, this._layers.length))
    this.splatChanged()
    void this.rebuildMaterial()
  }

  setLayer(index: number, changes: Partial<TerrainLayer>): void {
    const layer = this._layers[index]
    if (!layer)
      return
    this._layers = this._layers.map((l, i) => i === index
      ? {
          ...l,
          ...changes,
        }
      : l)
    void this.rebuildMaterial()
  }

  /** The index of the layer drawn with `graph`, or -1 */
  layerIndex(graph: string): number {
    return this._layers.findIndex(layer => layer.graph === graph)
  }

  /** How much of a layer (by its graph) covers the ground at a world position, 0 – 1 */
  layerWeightAt(point: Vector3, graph: string): number {
    const layer = this.layerIndex(graph)
    if (layer < 0)
      return 0
    const [u, v] = this.uvAt(this.toLocal(point))
    return this.splat.weightAtUv(layer, u, v)
  }

  // --- Coordinates ---

  toLocal(point: Vector3): Vector3 {
    this.instance.updateMatrixWorld()
    return this.instance.worldToLocal(point.clone())
  }

  toWorld(local: Vector3): Vector3 {
    this.instance.updateMatrixWorld()
    return this.instance.localToWorld(local.clone())
  }

  /** UV of a local position, 0 – 1 across the terrain */
  uvAt(local: Vector3): [number, number] {
    return [local.x / this._size + 0.5, local.z / this._size + 0.5]
  }

  /** Splatmap texel of a local position */
  texelAt(local: Vector3): [number, number] {
    const [u, v] = this.uvAt(local)
    return [u * this._splatResolution, v * this._splatResolution]
  }

  /** Meters in local space to splatmap texels */
  metersToTexels(meters: number): number {
    return meters / this._size * this._splatResolution
  }

  /** A local length of the terrain in world meters (its x scale) */
  get worldScale(): number {
    return Math.abs(this.instance.scale.x) || 1
  }

  /**
   * Where a world ray first meets the ground. Marches the heightmap rather than the mesh's triangles, which is
   * fast enough to follow the pointer
   */
  raycast(ray: Ray): TerrainHit | undefined {
    this.instance.updateMatrixWorld()
    const inverse = new Matrix4().copy(this.instance.matrixWorld).invert()
    const local = ray.clone().applyMatrix4(inverse)
    const half = this._size / 2
    const dir = local.direction.clone().normalize()
    const origin = local.origin

    // Clip to the terrain's box
    let tMin = 0
    let tMax = Infinity
    for (const axis of ['x', 'z'] as const) {
      if (Math.abs(dir[axis]) < 1e-9) {
        if (origin[axis] < -half || origin[axis] > half)
          return undefined
        continue
      }
      const t1 = (-half - origin[axis]) / dir[axis]
      const t2 = (half - origin[axis]) / dir[axis]
      tMin = Math.max(tMin, Math.min(t1, t2))
      tMax = Math.min(tMax, Math.max(t1, t2))
    }
    if (tMin > tMax)
      return undefined
    if (!Number.isFinite(tMax))
      tMax = tMin + this._size * 4

    const step = this.heightmap.spacing * 0.5
    const above = (t: number) => {
      const p = origin.clone().addScaledVector(dir, t)
      return p.y - this.heightmap.sample(p.x, p.z)
    }
    let prev = tMin
    // Starts under the ground
    if (above(prev) < 0)
      return undefined
    for (let t = tMin + step; t <= tMax + step; t += step) {
      const current = Math.min(t, tMax)
      const a = above(current)
      if (a <= 0) {
        // Narrow it down between the last two steps
        let lo = prev
        let hi = current
        for (let i = 0; i < 16; i++) {
          const mid = (lo + hi) / 2
          if (above(mid) > 0)
            lo = mid
          else
            hi = mid
        }
        const hit = origin.clone().addScaledVector(dir, hi)
        hit.y = this.heightmap.sample(hit.x, hit.z)
        return {
          local: hit,
          point: this.toWorld(hit),
          normal: this.normalAt(hit),
        }
      }
      prev = current
      if (current >= tMax)
        break
    }
    return undefined
  }

  /** World normal at a local position */
  normalAt(local: Vector3): Vector3 {
    const [gx, gz] = this.heightmap.toGrid(local.x, local.z)
    const [nx, ny, nz] = this.heightmap.normal(Math.round(gx), Math.round(gz))
    return new Vector3(nx, ny, nz).transformDirection(this.instance.matrixWorld)
  }

  // --- Changes from the brushes ---

  /** The heights of a region changed: redraw it. The collider follows on `commit()` */
  heightsChanged(region?: GridRegion): void {
    updateTerrainGeometry(this.instance.geometry, this.heightmap, region)
    this.encoded.heights = undefined
  }

  /** The splatmaps changed: upload them again */
  splatChanged(): void {
    this.syncSplatTextures()
    this.encoded.splat = undefined
    this.painted = true
  }

  /** A stroke is done: rebuild the collider from the new heights */
  commit(): void {
    this.heightsVersion++
    this.syncCollider()
  }

  /** Change the size, keeping the shape stretched over it */
  setSize(size: number): void {
    if (size === this._size || size <= 0)
      return
    this._size = size
    this.heightmap = this.heightmap.resample(this.heightmap.resolution, size)
    this.rebuildGeometry()
  }

  /** Change the number of height samples per side, resampling the heights */
  setResolution(resolution: number): void {
    if (resolution === this.heightmap.resolution)
      return
    this.heightmap = this.heightmap.resample(resolution)
    this.rebuildGeometry()
  }

  /** Change the splatmap's texels per side, resampling what is painted */
  setSplatResolution(resolution: number): void {
    const next = Math.min(MAX_SPLAT_RESOLUTION, Math.max(16, Math.round(resolution)))
    if (next === this._splatResolution)
      return
    this._splatResolution = next
    this.splat = this.splat.resample(next)
    this.splatChanged()
    void this.rebuildMaterial()
  }

  /** Replace the heights and splatmaps, e.g. to undo a stroke */
  replaceData(heightmap: Heightmap, splat: SplatMap): void {
    this.heightmap = heightmap
    this.splat = splat
    this._splatResolution = splat.resolution
    this.rebuildGeometry()
    this.splatChanged()
  }

  private rebuildGeometry(): void {
    this.instance.geometry.dispose()
    this.instance.geometry = buildTerrainGeometry(this.heightmap)
    this.encoded.heights = undefined
    this.commit()
  }

  private syncSplatTextures(): void {
    const res = this._splatResolution
    const sameShape = this.splatTextures.length === this.splat.maps.length
      && this.splatTextures.every((t, i) => t.image.width === res && t.image.data === this.splat.maps[i])
    if (sameShape) {
      this.splatTextures.forEach(t => (t.needsUpdate = true))
      return
    }
    this.splatTextures.forEach(t => t.dispose())
    this.splatTextures = this.splat.maps.map((map) => {
      const t = new DataTexture(map, res, res, RGBAFormat, UnsignedByteType)
      t.magFilter = LinearFilter
      t.minFilter = LinearFilter
      t.colorSpace = NoColorSpace
      t.needsUpdate = true
      return t
    })
    void this.rebuildMaterial()
  }

  private async rebuildMaterial(): Promise<void> {
    const version = ++this.materialVersion
    const material = await buildTerrainMaterial(this._layers, this.splatTextures, this.uniforms)
    if (version !== this.materialVersion || this.garbageCollect) {
      material.dispose()
      return
    }
    const previous = this.instance.material as Material
    this.instance.material = material
    previous.dispose()
    // The editor's shade modes swap materials: tell it this one changed
    Game.instance().editor?.trigger('assetDropped')
  }

  private syncCollider(): void {
    const world = Game.instance().physicsWorld
    if (!this._collision || !world) {
      this.collider?.destroy()
      this.collider = undefined
      this.colliderState = undefined
      return
    }
    const { position, quaternion, scale } = this.instance
    const placement = { position, quaternion, scale }
    const last = this.colliderState
    if (!this.collider)
      this.collider = new TerrainCollider(world, this.heightmap, placement)
    else if (!last || last.version !== this.heightsVersion || !last.scale.equals(scale))
      this.collider.reshape(this.heightmap, placement)
    else if (!last.position.equals(position) || !last.quaternion.equals(quaternion))
      this.collider.place(placement)
    else
      return
    this.colliderState = {
      position: position.clone(),
      quaternion: quaternion.clone(),
      scale: scale.clone(),
      version: this.heightsVersion,
    }
  }

  private properties(): PropertyField[] {
    const select = (label: string, values: number[], get: () => number, set: (v: number) => void): PropertyField => ({
      type: 'select',
      label,
      options: () => [
        ...new Set([
          ...values,
          get(),
        ]),
      ].sort((a, b) => a - b).map(v => ({
        value: String(v),
        label: String(v),
      })),
      getValue: () => String(get()),
      setValue: v => set(Number(v)),
    })
    return [
      {
        type: 'slider',
        label: 'size',
        min: 10,
        max: 4000,
        step: 10,
        getValue: () => this._size,
        setValue: v => this.setSize(v),
      },
      select('height samples', HEIGHT_RESOLUTIONS, () => this.heightmap.resolution, v => this.setResolution(v)),
      select('splat texels', SPLAT_RESOLUTIONS, () => this._splatResolution, v => this.setSplatResolution(v)),
      {
        type: 'select',
        label: 'splat preset',
        options: () => [
          { value: '', label: 'Pick for size…' },
          { value: '5', label: '5 / m (default)' },
          { value: '10', label: '10 / m' },
          { value: '2.5', label: '2.5 / m' },
        ],
        getValue: () => '',
        setValue: v => v && this.setSplatResolution(splatResolutionFor(this._size, Number(v))),
      },
      {
        type: 'slider',
        label: 'blend sharpness',
        min: 0,
        max: 1,
        step: 0.01,
        getValue: () => this.blendSharpness,
        setValue: (v) => { this.blendSharpness = v },
      },
      {
        type: 'checkbox',
        label: 'collision',
        getValue: () => this._collision,
        setValue: v => this.setCollision(v),
      },
      {
        type: 'checkbox',
        label: 'cast shadow',
        getValue: () => this.instance.castShadow,
        setValue: (v) => { this.instance.castShadow = v },
      },
      {
        type: 'checkbox',
        label: 'receive shadow',
        getValue: () => this.instance.receiveShadow,
        setValue: (v) => { this.instance.receiveShadow = v },
      },
    ]
  }

  update(_delta: number): void {
    this.syncCollider()
  }

  destroy(): void {
    this.unsubscribeGraphs?.()
    this.materialVersion++
    this.instance.geometry.dispose()
    ;(this.instance.material as Material).dispose()
    this.splatTextures.forEach(t => t.dispose())
    this.collider?.destroy()
    this.collider = undefined
    Game.instance().scene.remove(this.instance)
    super.destroy()
  }
}
