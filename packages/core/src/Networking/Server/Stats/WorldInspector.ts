import type BaseGame from '../../../BaseGame'
import type { EntityDetail, EntityList, EntityQuery, SceneInfo } from '../../../Dev/inspect'
import process from 'node:process'
import { describeScene, detailEntity, queryEntities, summarizeEntity } from '../../../Dev/inspect'
import Player from '../../Entities/Player'

export type { EntityDetail, EntityList, EntityQuery, EntitySummary, SceneObjectInfo } from '../../../Dev/inspect'
export { DEFAULT_ENTITY_LIMIT, MAX_ENTITY_LIMIT } from '../../../Dev/inspect'

/**
 * Whether the dev inspection endpoints (GET /api/game/dev/*) are served.
 * Only outside production: a metrics token does not turn them on there.
 */
export function devEndpointsEnabled(env: Record<string, string | undefined> = process.env) {
  return env.NODE_ENV !== 'production'
}

export interface ServerSceneInfo extends SceneInfo {
  /** Scene file on disk, when it was opened with `server.openScene()` */
  file: string | null
  /** Reloaded when the file changes */
  watching: boolean
}

export interface WorldInspectorSource {
  game: BaseGame
  /** File of the active scene, if the server opened it from one */
  readonly activeSceneFile?: string
  readonly sceneWatched: boolean
}

const isPlayer = (entity: unknown) => entity instanceof Player

/** The server's headless three.js scene graph: what is in `game.scene` */
export interface SceneGraphStats {
  /** Every Object3D below the scene, not the scene itself */
  objects: number
  /** How many of each `type`, e.g. `{ Mesh: 3, Group: 1 }`, most first */
  byType: Record<string, number>
  meshes: number
  /** Of the meshes' geometries */
  triangles: number
  lights: number
}

/** The server's Rapier world, null when the game runs without physics */
export interface PhysicsStats {
  bodies: number
  dynamic: number
  fixed: number
  kinematic: number
  sleeping: number
  colliders: number
  gravity: { x: number, y: number, z: number }
  /** Seconds per physics step */
  timestep: number
}

interface MeshLike {
  isMesh?: boolean
  isLight?: boolean
  type: string
  geometry?: { index?: { count: number } | null, getAttribute?(name: string): { count: number } | undefined }
}

function trianglesOf(geometry: MeshLike['geometry']): number {
  if (!geometry)
    return 0
  const count = geometry.index?.count ?? geometry.getAttribute?.('position')?.count ?? 0
  return Math.floor(count / 3)
}

/**
 * Read-only views of the server's scene and the entities in its world, served on the dev endpoints.
 */
export default class WorldInspector {
  constructor(private source: WorldInspectorSource) { }

  scene(): ServerSceneInfo | null {
    const scene = this.source.game.activeScene
    if (!scene)
      return null

    return {
      ...describeScene(scene),
      file: this.source.activeSceneFile ?? null,
      watching: this.source.sceneWatched,
    }
  }

  /** Counts of what the server's three.js scene graph holds */
  sceneGraph(): SceneGraphStats {
    const stats: SceneGraphStats = {
      objects: 0,
      byType: {},
      meshes: 0,
      triangles: 0,
      lights: 0,
    }
    const root = this.source.game.scene
    root?.traverse((node) => {
      if (node === root)
        return
      const object = node as unknown as MeshLike
      stats.objects++
      stats.byType[object.type] = (stats.byType[object.type] ?? 0) + 1
      if (object.isMesh) {
        stats.meshes++
        stats.triangles += trianglesOf(object.geometry)
      }
      if (object.isLight)
        stats.lights++
    })
    stats.byType = Object.fromEntries(Object.entries(stats.byType).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])))
    return stats
  }

  /** Counts of the server's physics world, null without one */
  physics(): PhysicsStats | null {
    const world = this.source.game.physicsWorld
    if (!world)
      return null

    const stats: PhysicsStats = {
      bodies: 0,
      dynamic: 0,
      fixed: 0,
      kinematic: 0,
      sleeping: 0,
      colliders: world.colliders.len(),
      gravity: { x: world.gravity.x, y: world.gravity.y, z: world.gravity.z },
      timestep: world.timestep,
    }
    world.bodies.forEach((body) => {
      stats.bodies++
      if (body.isDynamic())
        stats.dynamic++
      else if (body.isFixed())
        stats.fixed++
      else if (body.isKinematic())
        stats.kinematic++
      if (body.isSleeping())
        stats.sleeping++
    })
    return stats
  }

  entities(query: EntityQuery = {}): EntityList {
    const { world, activeScene } = this.source.game
    return queryEntities(Array.from(world.entities.items.values(), entity => summarizeEntity(entity, activeScene, isPlayer)), query)
  }

  entity(id: string): EntityDetail | null {
    const entity = this.source.game.world.entities.items.get(id)
    return entity
      ? detailEntity(entity, this.source.game.activeScene, isPlayer)
      : null
  }
}
