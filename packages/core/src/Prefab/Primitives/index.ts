import type { BufferGeometry, Material, Quaternion, Vector3 } from 'three'
import type { PropertyField } from '../../Editor/EditorHelper'
import type { GeometryParams, PrimitiveDefinition, PrimitiveName, PrimitiveOptions, PrimitivePivot } from './definitions'
import {
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshStandardMaterial,
} from 'three'
import { WithEditorHelper } from '../../Editor/WithEditorHelper'
import Game from '../../Game'
import { materialGraphs } from '../../Graph/Material/MaterialGraphs'
import GameObject from '../../World/GameObject'
import { PrimitiveCollider } from './collider'
import { buildPrimitiveGeometry, PRIMITIVE_DEFINITIONS, primitiveCollides, resolveParams } from './definitions'

export * from './collider'
export * from './definitions'

export abstract class Primitive extends WithEditorHelper(GameObject) {
  public instance: Mesh | LineSegments
  readonly definition: PrimitiveDefinition
  private _params: GeometryParams
  private _pivot: PrimitivePivot
  private _collision: boolean
  /** Set while the primitive collides and the game has a physics world */
  collider?: PrimitiveCollider
  /** Its own material, drawn while it has no material graph */
  readonly baseMaterial: Material
  private _materialGraph?: string
  /** What the collider was last built from, to notice when it needs moving or reshaping */
  private colliderState?: { geometry: BufferGeometry, position: Vector3, quaternion: Quaternion, scale: Vector3 }

  constructor(position: Vector3, definition: PrimitiveDefinition, params?: Partial<GeometryParams>, options: PrimitiveOptions = {}) {
    super(undefined, position)
    this.definition = definition
    this._params = resolveParams(definition, params)
    this._pivot = options.pivot ?? 'center'
    this._collision = primitiveCollides(definition, options.collision)
    const geometry = this.buildGeometry()
    this.instance = definition.lines
      ? new LineSegments(geometry, new LineBasicMaterial({ color: 0x4A9EFF }))
      : new Mesh(geometry, new MeshStandardMaterial({ color: 0x888888 }))
    this.baseMaterial = this.instance.material as Material
    this.instance.position.copy(position)
    Game.instance().scene.add(this.instance)
    this.registerEditorHelper(position, definition.label, {
      onMove: (delta: Vector3) => this.instance.position.add(delta),
      properties: [
        ...this.materialGraphProperty(),
        ...this.materialProperties(),
        this.pivotProperty(),
        ...this.collisionProperty(),
        ...this.geometryProperties(),
      ],
    })
    this.tagWithHelper(this.instance)
  }

  /** A copy of the current geometry params */
  get params(): GeometryParams {
    return { ...this._params }
  }

  /** Changes some geometry params and rebuilds the geometry. Unknown keys are ignored, values are clamped. */
  setParams(changes: Partial<GeometryParams>): void {
    const next = resolveParams(this.definition, {
      ...this._params,
      ...changes,
    })
    if (this.definition.params.every(p => next[p.key] === this._params[p.key]))
      return
    this._params = next
    this.rebuild()
  }

  get pivot(): PrimitivePivot {
    return this._pivot
  }

  /** Moves the origin. The origin stays where it is in the world, so the shape shifts around it. */
  setPivot(pivot: PrimitivePivot): void {
    if (pivot === this._pivot)
      return
    this._pivot = pivot
    this.rebuild()
  }

  get collision(): boolean {
    return this._collision
  }

  setCollision(collision: boolean): void {
    this._collision = primitiveCollides(this.definition, collision)
    this.syncCollider()
  }

  /**
   * Keeps the collider matching the mesh: creates or removes it, moves it with the mesh and
   * reshapes it when the geometry or scale changes. Runs every update, so editor changes apply on the next tick.
   */
  syncCollider(): void {
    const world = Game.instance().physicsWorld
    if (!this._collision || !world) {
      this.removeCollider()
      return
    }

    const { geometry, position, quaternion, scale } = this.instance
    const placement = { position, quaternion, scale }
    const last = this.colliderState
    if (!this.collider) {
      this.collider = new PrimitiveCollider(world, geometry, placement)
    }
    else if (last && (last.geometry !== geometry || !last.scale.equals(scale))) {
      this.collider.reshape(geometry, placement)
    }
    else if (last && (!last.position.equals(position) || !last.quaternion.equals(quaternion))) {
      this.collider.place(placement)
    }
    else {
      return
    }

    this.colliderState = {
      geometry,
      position: position.clone(),
      quaternion: quaternion.clone(),
      scale: scale.clone(),
    }
  }

  private removeCollider(): void {
    this.collider?.destroy()
    this.collider = undefined
    this.colliderState = undefined
  }

  private collisionProperty(): PropertyField[] {
    if (this.definition.lines)
      return []
    return [
      {
        type: 'checkbox',
        label: 'collision',
        getValue: () => this._collision,
        setValue: (v: boolean) => this.setCollision(v),
      },
    ]
  }

  private buildGeometry(): BufferGeometry {
    return buildPrimitiveGeometry(this.definition, this._params, this._pivot)
  }

  private rebuild(): void {
    this.instance.geometry.dispose()
    this.instance.geometry = this.buildGeometry()
  }

  private pivotProperty(): PropertyField {
    return {
      type: 'checkbox',
      label: 'pivot at base',
      getValue: () => this._pivot === 'base',
      setValue: (v: boolean) => this.setPivot(v
        ? 'base'
        : 'center'),
    }
  }

  setParam(key: string, value: number): void {
    this.setParams({ [key]: value })
  }

  /** The material graph it is drawn with, see `setMaterialGraph()` */
  get materialGraph(): string | undefined {
    return this._materialGraph
  }

  /**
   * Draw it with a material graph from `graphs/<name>.graph.json`, or with its own material again without a name.
   * Its own material's settings (color, roughness...) are kept for when the graph is taken off
   */
  setMaterialGraph(name?: string): void {
    const mesh = this.instance
    if (!(mesh instanceof Mesh) || name === this._materialGraph)
      return

    this._materialGraph = name || undefined
    if (!name) {
      materialGraphs.release(mesh)
      mesh.material = this.baseMaterial
      return
    }

    materialGraphs.apply(mesh, name).catch((err: Error) => {
      Game.instance().logger?.warn(`${this.definition.label}: could not use material graph "${name}": ${err.message}`)
      if (this._materialGraph === name)
        mesh.material = this.baseMaterial
    })
  }

  private materialGraphProperty(): PropertyField[] {
    if (this.definition.lines)
      return []
    return [
      {
        type: 'select',
        label: 'material graph',
        options: () => [
          { value: '', label: 'None' },
          ...materialGraphs.list
            .filter(graph => graph.kind === 'material')
            .map(graph => ({ value: graph.name, label: graph.name })),
        ],
        getValue: () => this._materialGraph ?? '',
        setValue: (v: string) => this.setMaterialGraph(v || undefined),
        refresh: () => materialGraphs.refreshList(),
      },
    ]
  }

  private materialProperties(): PropertyField[] {
    const mat = this.instance.material
    if (!(mat instanceof MeshStandardMaterial))
      return []
    return [
      {
        type: 'color',
        label: 'color',
        getValue: () => `#${mat.color.getHexString()}`,
        setValue: (v: string) => mat.color.set(v),
      },
      {
        type: 'checkbox',
        label: 'wireframe',
        getValue: () => mat.wireframe,
        setValue: (v: boolean) => {
          mat.wireframe = v
          mat.needsUpdate = true
        },
      },
      {
        type: 'slider',
        label: 'roughness',
        min: 0,
        max: 1,
        step: 0.01,
        getValue: () => mat.roughness,
        setValue: (v: number) => { mat.roughness = v },
      },
      {
        type: 'slider',
        label: 'metalness',
        min: 0,
        max: 1,
        step: 0.01,
        getValue: () => mat.metalness,
        setValue: (v: number) => { mat.metalness = v },
      },
    ]
  }

  private geometryProperties(): PropertyField[] {
    return this.definition.params.map(param => ({
      type: 'slider',
      label: param.key,
      min: param.min,
      max: param.max,
      step: param.step,
      getValue: () => this._params[param.key],
      setValue: (v: number) => this.setParam(param.key, v),
    }))
  }

  setReceiveShadow(value: boolean): void {
    this.instance.receiveShadow = value
  }

  setCastShadow(value: boolean): void {
    this.instance.castShadow = value
  }

  update(_delta: number): void {
    this.syncCollider()
  }

  destroy(): void {
    this.instance.geometry.dispose()
    // A material graph's material is shared, only its own is disposed
    if (this.instance instanceof Mesh)
      materialGraphs.release(this.instance)
    this.baseMaterial.dispose()
    this.removeCollider()
    Game.instance().scene.remove(this.instance)
    super.destroy()
  }
}

export type PrimitiveConstructor = new (position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) => Primitive

export class BoxPrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Box, params, options)
  }
}

export class CapsulePrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Capsule, params, options)
  }
}

export class CirclePrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Circle, params, options)
  }
}

export class ConePrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Cone, params, options)
  }
}

export class CylinderPrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Cylinder, params, options)
  }
}

export class DodecahedronPrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Dodecahedron, params, options)
  }
}

export class EdgesPrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Edges, params, options)
  }
}

export class ExtrudePrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Extrude, params, options)
  }
}

export class IcosahedronPrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Icosahedron, params, options)
  }
}

export class LathePrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Lathe, params, options)
  }
}

export class OctahedronPrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Octahedron, params, options)
  }
}

export class PlanePrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Plane, params, options)
  }

  get width(): number {
    return this.params.width
  }

  get height(): number {
    return this.params.height
  }
}

export class PolyhedronPrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Polyhedron, params, options)
  }
}

export class RingPrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Ring, params, options)
  }
}

export class ShapePrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Shape, params, options)
  }
}

export class SpherePrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Sphere, params, options)
  }
}

export class StairsPrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Stairs, params, options)
  }
}

export class TetrahedronPrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Tetrahedron, params, options)
  }
}

export class TorusPrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Torus, params, options)
  }
}

export class TorusKnotPrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.TorusKnot, params, options)
  }
}

export class TubePrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Tube, params, options)
  }
}

export class WireframePrimitive extends Primitive {
  constructor(position: Vector3, params?: Partial<GeometryParams>, options?: PrimitiveOptions) {
    super(position, PRIMITIVE_DEFINITIONS.Wireframe, params, options)
  }
}

export const PRIMITIVE_REGISTRY: Record<string, PrimitiveConstructor> & Record<PrimitiveName, PrimitiveConstructor> = {
  Box: BoxPrimitive,
  Capsule: CapsulePrimitive,
  Circle: CirclePrimitive,
  Cone: ConePrimitive,
  Cylinder: CylinderPrimitive,
  Dodecahedron: DodecahedronPrimitive,
  Edges: EdgesPrimitive,
  Extrude: ExtrudePrimitive,
  Icosahedron: IcosahedronPrimitive,
  Lathe: LathePrimitive,
  Octahedron: OctahedronPrimitive,
  Plane: PlanePrimitive,
  Polyhedron: PolyhedronPrimitive,
  Ring: RingPrimitive,
  Shape: ShapePrimitive,
  Sphere: SpherePrimitive,
  Stairs: StairsPrimitive,
  Tetrahedron: TetrahedronPrimitive,
  Torus: TorusPrimitive,
  TorusKnot: TorusKnotPrimitive,
  Tube: TubePrimitive,
  Wireframe: WireframePrimitive,
}
