import type BaseGame from '../../../BaseGame'
import type { SceneSettings, SceneTransform } from '../../../Scene/types'
import type GameObject from '../../../World/GameObject'
import process from 'node:process'
import { getSceneObject } from '../../../Scene/SceneObjectRegistry'
import Player from '../../Entities/Player'
import NetworkedGameObject from '../../NetworkedGameObject'

/**
 * Whether the dev inspection endpoints (GET /api/game/dev/*) are served.
 * Only outside production: a metrics token does not turn them on there.
 */
export function devEndpointsEnabled(env: Record<string, string | undefined> = process.env) {
  return env.NODE_ENV !== 'production'
}

interface Vec3 { x: number, y: number, z: number }

export interface EntitySummary {
  id: string
  /** Class name, or the networked `$typeName` when it has one */
  type: string
  position: Vec3
  rotation: Vec3
  scale: Vec3
  networked: boolean
  player: boolean
  /** Set when the entity was built from an object in the active scene */
  sceneObject: { type: string, name?: string } | null
  /** Flagged for removal on the next tick */
  garbageCollect: boolean
}

export interface EntityDetail extends EntitySummary {
  /** What the entity sends over the network (`serialize()`), null when it doesn't turn into JSON */
  serialized: unknown
}

export interface EntityQuery {
  /** Case-insensitive match on the entity type or its scene object type */
  type?: string
  /** Only entities within `radius` of this point, nearest first */
  near?: Vec3
  radius?: number
  limit?: number
  offset?: number
}

export interface EntityList {
  /** Matches before `limit` / `offset` */
  total: number
  entities: EntitySummary[]
}

export interface SceneObjectInfo {
  id: string
  type: string
  name?: string
  transform: SceneTransform
  props?: Record<string, unknown>
  /** Whether the server built an object for it. False for client-only types */
  built: boolean
  /** Plugin that registered the type, null for the project's and built-in types, undefined when the type is unknown */
  plugin?: string | null
}

export interface SceneInfo {
  name: string
  /** File name without `.json` */
  source: string | null
  /** Scene file on disk, when it was opened with `server.openScene()` */
  file: string | null
  /** Reloaded when the file changes */
  watching: boolean
  dirty: boolean
  settings: SceneSettings
  objects: SceneObjectInfo[]
}

export interface WorldInspectorSource {
  game: BaseGame
  /** File of the active scene, if the server opened it from one */
  readonly activeSceneFile?: string
  readonly sceneWatched: boolean
}

export const DEFAULT_ENTITY_LIMIT = 50
export const MAX_ENTITY_LIMIT = 500

/**
 * Read-only views of the scene and the entities in the world, served on the dev endpoints.
 */
export default class WorldInspector {
  constructor(private source: WorldInspectorSource) { }

  scene(): SceneInfo | null {
    const scene = this.source.game.activeScene
    if (!scene)
      return null

    // serialize() also captures the current transforms of the built objects
    const data = scene.serialize()
    const objects = data.objects.map((object): SceneObjectInfo => {
      const definition = getSceneObject(object.type)
      return {
        ...object,
        built: !!scene.get(object.id)?.object,
        plugin: definition ? (definition.plugin ?? null) : undefined,
      }
    })

    return {
      name: scene.name,
      source: scene.source ?? null,
      file: this.source.activeSceneFile ?? null,
      watching: this.source.sceneWatched,
      dirty: scene.isDirty(),
      settings: data.settings ?? {},
      objects,
    }
  }

  entities(query: EntityQuery = {}): EntityList {
    const type = query.type?.toLowerCase()
    const limit = Math.min(Math.max(0, query.limit ?? DEFAULT_ENTITY_LIMIT), MAX_ENTITY_LIMIT)
    const offset = Math.max(0, query.offset ?? 0)

    let matches = Array.from(this.source.game.world.entities.items.values(), entity => this.summarize(entity))
      .filter(entity => !type || entity.type.toLowerCase() === type || entity.sceneObject?.type.toLowerCase() === type)

    const { near } = query
    if (near) {
      const radius = query.radius ?? Infinity
      matches = matches
        .map(entity => ({ entity, distance: distance(entity.position, near) }))
        .filter(({ distance }) => distance <= radius)
        .sort((a, b) => a.distance - b.distance)
        .map(({ entity }) => entity)
    }

    return { total: matches.length, entities: matches.slice(offset, offset + limit) }
  }

  entity(id: string): EntityDetail | null {
    const entity = this.source.game.world.entities.items.get(id)
    if (!entity)
      return null

    return { ...this.summarize(entity), serialized: toJson(() => entity.serialize()) }
  }

  private summarize(entity: GameObject): EntitySummary {
    const entry = this.source.game.activeScene?.entryOf(entity)
    const networked = entity instanceof NetworkedGameObject

    return {
      id: entity.id,
      type: (networked && (entity as NetworkedGameObject).$typeName) || entity.constructor.name,
      position: vec(entity.position),
      rotation: vec(entity.rotation),
      scale: vec(entity.scale),
      networked,
      player: entity instanceof Player,
      sceneObject: entry ? { type: entry.data.type, ...(entry.data.name ? { name: entry.data.name } : {}) } : null,
      garbageCollect: entity.garbageCollect,
    }
  }
}

function vec(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z }
}

function distance(a: Vec3, b: Vec3) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** The value as plain JSON, or null when it can't be serialized (e.g. circular references) */
function toJson(value: () => unknown): unknown {
  try {
    const json = JSON.stringify(value())
    return json === undefined ? null : JSON.parse(json)
  }
  catch {
    return null
  }
}
