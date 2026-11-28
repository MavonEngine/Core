import type { Collider } from '@dimforge/rapier3d-compat'
import type { BufferGeometry, Material } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { PropertyField } from '../Editor/EditorHelper'
import type { SceneObjectData } from '../Scene/types'
import type { ScatterBrushEntry } from './scatterBrush'
import type { ScatterGroup, ScatterInstance, ScatterLayerProps } from './scatterData'
import { Box3, Group, InstancedMesh, Matrix4, Mesh, Quaternion, Vector3 } from 'three'
import { WithEditorHelper } from '../Editor/WithEditorHelper'
import Game from '../Game'
import GameObject from '../World/GameObject'
import {
  buildScatterColliders,
  colliderFromBounds,
  INSTANCE_STRIDE,
  instanceCount,
  pushInstance,
  readInstance,
  removeColliders,
  scatterPropsFrom,
  serializeScatterProps,
} from './scatterData'

interface Part {
  geometry: BufferGeometry
  material: Material | Material[]
  /** Where the part sits in the model */
  matrix: Matrix4
  castShadow: boolean
}

interface Render {
  meshes: InstancedMesh[]
  capacity: number
}

/** Marks the meshes of scatter layers, so brushes don't paint onto the instances they painted */
export const SCATTER_MESH_FLAG = 'scatterInstances'

/**
 * Assets painted with a scatter brush, on the client: one InstancedMesh per part of each asset. Instances are kept
 * relative to the layer, which sits at the origin unless moved. Call `commit()` after a stroke so the colliders
 * catch up.
 */
export default class ScatterLayer extends WithEditorHelper(GameObject) {
  instance: Group
  readonly props: ScatterLayerProps
  private renders = new Map<string, Render>()
  private colliders: Collider[] = []
  private colliderMatrix?: Matrix4
  private dataVersion = 0
  private colliderVersion = -1
  private offAssets?: () => void
  /** What the groups encode to, kept until they change */
  private encoded?: Record<string, unknown>
  private pendingRefresh = new Set<string>()

  constructor(data: SceneObjectData) {
    super(undefined, new Vector3(...data.transform.position))
    this.props = scatterPropsFrom(data.props)
    this.instance = new Group()
    this.instance.name = 'Scatter layer'
    this.instance.position.copy(this.position)
    Game.instance().scene.add(this.instance)

    this.props.groups.forEach(group => this.refresh(group.asset))

    // Models loaded later, e.g. imported in the editor
    const resources = Game.instance().resources
    const onAssets = () => this.props.groups.forEach((group) => {
      if (!this.renders.has(group.asset))
        this.refresh(group.asset)
    })
    resources.on('assetsAdded', onAssets)
    resources.on('loaded', onAssets)
    this.offAssets = () => {
      resources.off?.('assetsAdded', onAssets)
      resources.off?.('loaded', onAssets)
    }

    this.registerEditorHelper(this.position.clone(), 'Scatter layer', {
      onMove: delta => this.instance.position.add(delta),
      properties: this.properties(),
    })
    this.tagWithHelper(this.instance)
  }

  get groups(): ScatterGroup[] {
    return this.props.groups
  }

  group(asset: string): ScatterGroup | undefined {
    return this.props.groups.find(g => g.asset === asset)
  }

  /** The model of an asset, when it is loaded */
  model(asset: string): GLTF | undefined {
    const item = Game.instance().resources.items[asset] as unknown as GLTF | undefined
    return item && 'scene' in item
      ? item
      : undefined
  }

  /** An asset's model bounds, as [min, max], measured once */
  private bounds = new Map<string, [[number, number, number], [number, number, number]] | null>()

  private boundsOf(asset: string): [[number, number, number], [number, number, number]] | undefined {
    if (!this.bounds.has(asset)) {
      const model = this.model(asset)
      if (!model)
        return undefined
      model.scene.updateMatrixWorld(true)
      const box = new Box3().setFromObject(model.scene)
      this.bounds.set(asset, box.isEmpty()
        ? null
        : [
            box.min.toArray(),
            box.max.toArray(),
          ])
    }
    return this.bounds.get(asset) ?? undefined
  }

  /** The settings a brush entry gives its asset's group: collision, the collider fitted to the model, shadows */
  private settingsOf(entry: ScatterBrushEntry): Omit<ScatterGroup, 'asset' | 'instances'> {
    const bounds = this.boundsOf(entry.asset)
    return {
      collision: entry.collision,
      collider: bounds
        ? colliderFromBounds(entry.collider.shape, entry.collider.fit, bounds[0], bounds[1])
        : undefined,
      castShadow: entry.castShadow,
      receiveShadow: entry.receiveShadow,
    }
  }

  /**
   * The group a brush entry paints into, made the first time. The entry's settings (shadows, collision, collider)
   * apply to the asset's instances already painted too
   */
  ensureGroup(entry: ScatterBrushEntry): ScatterGroup | undefined {
    const existing = this.group(entry.asset)
    if (existing) {
      this.applyEntry(entry)
      return existing
    }
    if (!this.model(entry.asset))
      return undefined
    const group: ScatterGroup = {
      asset: entry.asset,
      ...this.settingsOf(entry),
      instances: [],
    }
    this.props.groups.push(group)
    return group
  }

  /**
   * Give the painted instances of the entry's asset the entry's settings, e.g. after the brush was edited.
   * Returns whether anything changed
   */
  applyEntry(entry: ScatterBrushEntry): boolean {
    const group = this.group(entry.asset)
    if (!group || !this.model(entry.asset))
      return false
    const next = this.settingsOf(entry)
    const same = group.collision === next.collision
      && group.castShadow === next.castShadow
      && group.receiveShadow === next.receiveShadow
      && JSON.stringify(group.collider) === JSON.stringify(next.collider)
    if (same)
      return false
    this.setGroup(entry.asset, next)
    return true
  }

  /** World transform → the layer's own space */
  toLocal(instance: ScatterInstance): ScatterInstance {
    this.instance.updateMatrixWorld()
    const m = new Matrix4().compose(instance.position, instance.quaternion, instance.scale).premultiply(new Matrix4().copy(this.instance.matrixWorld).invert())
    const out = {
      position: new Vector3(),
      quaternion: new Quaternion(),
      scale: new Vector3(),
    }
    m.decompose(out.position, out.quaternion, out.scale)
    return out
  }

  /** A world point in the layer's own space */
  pointToLocal(point: Vector3): Vector3 {
    this.instance.updateMatrixWorld()
    return this.instance.worldToLocal(point.clone())
  }

  /** Add an instance (in world space) */
  add(asset: string, instance: ScatterInstance): void {
    const group = this.group(asset)
    if (!group)
      return
    pushInstance(group, this.toLocal(instance))
    this.changed(asset)
  }

  /**
   * Is an instance of `asset` (of any, without) closer than `spacing` to a world point. Spacing is kept per asset, so
   * a brush can mix small plants in between larger ones
   */
  crowded(point: Vector3, spacing: number, asset?: string): boolean {
    if (spacing <= 0)
      return false
    const local = this.pointToLocal(point)
    const s2 = spacing * spacing
    for (const group of this.props.groups) {
      if (asset && group.asset !== asset)
        continue
      const d = group.instances
      for (let i = 0; i < d.length; i += INSTANCE_STRIDE) {
        const dx = d[i] - local.x
        const dz = d[i + 2] - local.z
        if (dx * dx + dz * dz < s2 && Math.abs(d[i + 1] - local.y) < spacing * 4)
          return true
      }
    }
    return false
  }

  /** How many instances of an asset (or of all) are within `radius` of a world point, on x and z */
  countWithin(point: Vector3, radius: number, asset?: string): number {
    const local = this.pointToLocal(point)
    const r2 = radius * radius
    let count = 0
    for (const group of this.props.groups) {
      if (asset && group.asset !== asset)
        continue
      const d = group.instances
      for (let i = 0; i < d.length; i += INSTANCE_STRIDE) {
        const dx = d[i] - local.x
        const dz = d[i + 2] - local.z
        if (dx * dx + dz * dz < r2)
          count++
      }
    }
    return count
  }

  /**
   * Remove instances within `radius` of a world point: of the given assets (all without), each with a chance of
   * `fraction`. Returns how many went
   */
  removeWithin(point: Vector3, radius: number, assets?: Set<string>, fraction = 1, random = Math.random): number {
    const local = this.pointToLocal(point)
    const r2 = radius * radius
    let removed = 0
    for (const group of this.props.groups) {
      if (assets && !assets.has(group.asset))
        continue
      const d = group.instances
      const kept: number[] = []
      for (let i = 0; i < d.length; i += INSTANCE_STRIDE) {
        const dx = d[i] - local.x
        const dz = d[i + 2] - local.z
        if (dx * dx + dz * dz < r2 && random() < fraction) {
          removed++
          continue
        }
        for (let k = 0; k < INSTANCE_STRIDE; k++)
          kept.push(d[i + k])
      }
      if (kept.length !== d.length) {
        group.instances = kept
        this.refresh(group.asset)
      }
    }
    if (removed)
      this.changed()
    return removed
  }

  /** Every group's instances, to put back with `restore()` */
  snapshot(): ScatterGroup[] {
    return this.props.groups.map(g => ({
      ...g,
      instances: g.instances.slice(),
    }))
  }

  restore(groups: ScatterGroup[]): void {
    const assets = new Set([
      ...this.props.groups,
      ...groups,
    ].map(g => g.asset))
    this.props.groups.splice(0, this.props.groups.length, ...groups.map(g => ({
      ...g,
      instances: g.instances.slice(),
    })))
    assets.forEach(asset => this.refresh(asset))
    this.changed()
    this.commit()
  }

  /** Change a group's settings, e.g. collision */
  setGroup(asset: string, changes: Partial<Omit<ScatterGroup, 'asset' | 'instances'>>): void {
    const group = this.group(asset)
    if (!group)
      return
    Object.assign(group, changes)
    this.refresh(asset)
    this.changed()
    this.commit()
  }

  /** The data changed; `asset` to redraw that group on the next `flush()` */
  private changed(asset?: string): void {
    this.dataVersion++
    this.encoded = undefined
    if (asset)
      this.pendingRefresh.add(asset)
  }

  /** Redraw the groups that changed since the last call. Runs every update */
  flush(): void {
    if (!this.pendingRefresh.size)
      return
    const assets = [...this.pendingRefresh]
    this.pendingRefresh.clear()
    assets.forEach(asset => this.refresh(asset))
  }

  /** A stroke is done: rebuild the colliders */
  commit(): void {
    this.flush()
    this.syncColliders(true)
  }

  /** The parts of a model, with where each sits in it */
  private parts(asset: string): Part[] | undefined {
    const model = this.model(asset)
    if (!model)
      return undefined
    model.scene.updateMatrixWorld(true)
    const root = new Matrix4().copy(model.scene.matrixWorld).invert()
    const parts: Part[] = []
    model.scene.traverse((o) => {
      if (o instanceof Mesh && !(o instanceof InstancedMesh)) {
        parts.push({
          geometry: o.geometry,
          material: o.material,
          matrix: o.matrixWorld.clone().premultiply(root),
          castShadow: o.castShadow,
        })
      }
    })
    return parts
  }

  /** Rebuild an asset's instanced meshes from its group */
  private refresh(asset: string): void {
    const group = this.group(asset)
    const render = this.renders.get(asset)
    const count = group
      ? instanceCount(group)
      : 0
    if (!group || !count) {
      if (render) {
        render.meshes.forEach(mesh => this.disposeMesh(mesh))
        this.renders.delete(asset)
      }
      return
    }

    const parts = this.parts(asset)
    if (!parts?.length)
      return

    let current = render
    if (!current || current.capacity < count) {
      current?.meshes.forEach(mesh => this.disposeMesh(mesh))
      const capacity = Math.max(16, 2 ** Math.ceil(Math.log2(count)))
      current = {
        capacity,
        meshes: parts.map((part) => {
          const mesh = new InstancedMesh(part.geometry, part.material, capacity)
          mesh.userData[SCATTER_MESH_FLAG] = true
          mesh.userData.partMatrix = part.matrix
          mesh.frustumCulled = false
          this.instance.add(mesh)
          this.tagWithHelper(mesh)
          return mesh
        }),
      }
      this.renders.set(asset, current)
    }

    const instance = {
      position: new Vector3(),
      quaternion: new Quaternion(),
      scale: new Vector3(),
    }
    const matrix = new Matrix4()
    for (const mesh of current.meshes) {
      const partMatrix = mesh.userData.partMatrix as Matrix4
      for (let i = 0; i < count; i++) {
        readInstance(group, i, instance)
        matrix.compose(instance.position, instance.quaternion, instance.scale).multiply(partMatrix)
        mesh.setMatrixAt(i, matrix)
      }
      mesh.count = count
      mesh.castShadow = group.castShadow
      mesh.receiveShadow = group.receiveShadow
      mesh.instanceMatrix.needsUpdate = true
      mesh.computeBoundingSphere()
      mesh.computeBoundingBox()
    }
  }

  private disposeMesh(mesh: InstancedMesh): void {
    this.instance.remove(mesh)
    // The geometry and material belong to the model
    mesh.dispose()
  }

  private syncColliders(force = false): void {
    const world = Game.instance().physicsWorld
    if (!world) {
      return
    }
    this.instance.updateMatrixWorld()
    const moved = !this.colliderMatrix?.equals(this.instance.matrixWorld)
    if (!force && !moved && this.colliderVersion === this.dataVersion)
      return
    removeColliders(world, this.colliders)
    this.colliders = buildScatterColliders(world, this.props, this.instance.matrixWorld)
    this.colliderMatrix = this.instance.matrixWorld.clone()
    this.colliderVersion = this.dataVersion
  }

  sceneProps(): Record<string, unknown> {
    this.encoded ??= serializeScatterProps(this.props)
    return this.encoded
  }

  /** Turn the colliders of every group on or off */
  setCollision(collision: boolean): void {
    this.props.collision = collision
    this.changed()
    this.commit()
  }

  private properties(): PropertyField[] {
    return [
      {
        type: 'checkbox',
        label: 'collision',
        getValue: () => this.props.collision,
        setValue: v => this.setCollision(v),
      },
    ]
  }

  update(_delta: number): void {
    this.flush()
    // Moving the layer in the editor moves its colliders; painting rebuilds them on commit()
    if (this.colliderVersion === this.dataVersion || this.colliderVersion < 0)
      this.syncColliders(this.colliderVersion < 0)
  }

  destroy(): void {
    this.offAssets?.()
    this.renders.forEach(render => render.meshes.forEach(mesh => this.disposeMesh(mesh)))
    this.renders.clear()
    const world = Game.instance().physicsWorld
    if (world)
      removeColliders(world, this.colliders)
    Game.instance().scene.remove(this.instance)
    super.destroy()
  }
}
