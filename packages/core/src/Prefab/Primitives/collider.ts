import type { Collider, World } from '@dimforge/rapier3d-compat'
import type { BufferGeometry, Quaternion, Vector3 } from 'three'
import RAPIER from '@dimforge/rapier3d-compat'

/** Where a primitive is: its position, rotation and scale in the world */
export interface PrimitivePlacement {
  position: Vector3
  quaternion: Quaternion
  scale: Vector3
}

/**
 * A fixed triangle mesh collider shaped like a primitive's geometry.
 * The same code runs on the client and the server, so both collide with the same shape.
 *
 * Scale is baked into the vertices, since Rapier colliders can't be scaled; position and rotation are set on the collider.
 */
export class PrimitiveCollider {
  collider: Collider
  private readonly world: World

  constructor(world: World, geometry: BufferGeometry, placement: PrimitivePlacement) {
    this.world = world
    this.collider = world.createCollider(PrimitiveCollider.desc(geometry, placement.scale))
    this.place(placement)
  }

  static desc(geometry: BufferGeometry, scale: Vector3): RAPIER.ColliderDesc {
    const source = geometry.getAttribute('position')
    const vertices = new Float32Array(source.count * 3)
    for (let i = 0; i < source.count; i++) {
      vertices[i * 3] = source.getX(i) * scale.x
      vertices[i * 3 + 1] = source.getY(i) * scale.y
      vertices[i * 3 + 2] = source.getZ(i) * scale.z
    }

    const index = geometry.getIndex()
    const indices = index
      ? Uint32Array.from(index.array)
      : Uint32Array.from({ length: source.count }, (_, i) => i)

    return RAPIER.ColliderDesc.trimesh(vertices, indices)
  }

  /** Moves the collider without changing its shape */
  place(placement: Pick<PrimitivePlacement, 'position' | 'quaternion'>): void {
    const { position: p, quaternion: q } = placement
    this.collider.setTranslation({ x: p.x, y: p.y, z: p.z })
    this.collider.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
  }

  /** Replaces the shape, e.g. after the geometry or scale changed */
  reshape(geometry: BufferGeometry, placement: PrimitivePlacement): void {
    this.world.removeCollider(this.collider, false)
    this.collider = this.world.createCollider(PrimitiveCollider.desc(geometry, placement.scale))
    this.place(placement)
  }

  destroy(): void {
    this.world.removeCollider(this.collider, false)
  }
}
