import type { Collider, World } from '@dimforge/rapier3d-compat'
import type { Quaternion, Vector3 } from 'three'
import type { Heightmap } from './terrainData'
import RAPIER from '@dimforge/rapier3d-compat'

export interface TerrainPlacement {
  position: Vector3
  quaternion: Quaternion
  scale: Vector3
}

/**
 * A fixed heightfield collider shaped like a terrain. The client and the server build it from the same heights
 */
export class TerrainCollider {
  collider: Collider

  constructor(private readonly world: World, heightmap: Heightmap, placement: TerrainPlacement) {
    this.collider = world.createCollider(TerrainCollider.desc(heightmap, placement.scale))
    this.place(placement)
  }

  static desc(heightmap: Heightmap, scale: Vector3): RAPIER.ColliderDesc {
    const cells = heightmap.resolution - 1
    return RAPIER.ColliderDesc.heightfield(cells, cells, heightmap.toColumnMajor(), {
      x: heightmap.size * scale.x,
      y: scale.y,
      z: heightmap.size * scale.z,
    })
  }

  place(placement: Pick<TerrainPlacement, 'position' | 'quaternion'>): void {
    const { position: p, quaternion: q } = placement
    this.collider.setTranslation({ x: p.x, y: p.y, z: p.z })
    this.collider.setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
  }

  /** Replaces the shape, after the heights or the scale changed */
  reshape(heightmap: Heightmap, placement: TerrainPlacement): void {
    this.world.removeCollider(this.collider, false)
    this.collider = this.world.createCollider(TerrainCollider.desc(heightmap, placement.scale))
    this.place(placement)
  }

  destroy(): void {
    this.world.removeCollider(this.collider, false)
  }
}
