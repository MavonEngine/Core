import type GameScene from '../Scene/GameScene'
import type { SceneSettings, SceneTransform } from '../Scene/types'
import type GameObject from '../World/GameObject'
import NetworkedGameObject from '../Networking/NetworkedGameObject'
import { getSceneObject } from '../Scene/SceneObjectRegistry'

/**
 * Read-only descriptions of scenes and entities, shared by the server's dev endpoints and the client dev bridge
 * so both sides describe the world in the same shape. No Node or DOM APIs in here.
 */

export interface Vec3 { x: number, y: number, z: number }

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
  /** Whether this side built an object for it. False for types the other side only builds */
  built: boolean
  /** Plugin that registered the type, null for the project's and built-in types, undefined when the type is unknown here */
  plugin?: string | null
}

export interface SceneInfo {
  name: string
  side: 'client' | 'server'
  /** File name without `.json` */
  source: string | null
  dirty: boolean
  settings: SceneSettings
  objects: SceneObjectInfo[]
}

export const DEFAULT_ENTITY_LIMIT = 50
export const MAX_ENTITY_LIMIT = 500

export function describeScene(scene: GameScene): SceneInfo {
  // serialize() also captures the current transforms of the built objects
  const data = scene.serialize()

  return {
    name: scene.name,
    side: scene.side,
    source: scene.source ?? null,
    dirty: scene.isDirty(),
    settings: data.settings ?? {},
    objects: data.objects.map((object): SceneObjectInfo => {
      const definition = getSceneObject(object.type)
      return {
        ...object,
        built: !!scene.get(object.id)?.object,
        plugin: definition ? (definition.plugin ?? null) : undefined,
      }
    }),
  }
}

/**
 * Describe one entity. `isPlayer` tells which entities are players: server and client use different player classes
 */
export function summarizeEntity(entity: GameObject, scene: GameScene | undefined, isPlayer: (entity: GameObject) => boolean): EntitySummary {
  const entry = scene?.entryOf(entity)
  const networked = entity instanceof NetworkedGameObject

  return {
    id: entity.id,
    type: (networked && (entity as NetworkedGameObject).$typeName) || entity.constructor.name,
    position: vec(entity.position),
    rotation: vec(entity.rotation),
    scale: vec(entity.scale),
    networked,
    player: isPlayer(entity),
    sceneObject: entry ? { type: entry.data.type, ...(entry.data.name ? { name: entry.data.name } : {}) } : null,
    garbageCollect: entity.garbageCollect,
  }
}

export function detailEntity(entity: GameObject, scene: GameScene | undefined, isPlayer: (entity: GameObject) => boolean): EntityDetail {
  return { ...summarizeEntity(entity, scene, isPlayer), serialized: toJson(() => entity.serialize()) }
}

/**
 * The entity filters of a query string (`type`, `near=x,y,z`, `radius`, `limit`, `offset`), or an error message
 */
export function parseEntityQuery(query: Record<string, unknown>): EntityQuery | string {
  const result: EntityQuery = {}
  const text = (key: string) => typeof query[key] === 'string' && query[key] !== '' ? query[key] as string : undefined

  const type = text('type')
  if (type)
    result.type = type

  const near = text('near')
  if (near) {
    const parts = near.split(',').map(Number)
    if (parts.length !== 3 || parts.some(n => !Number.isFinite(n)))
      return 'near must be x,y,z'
    result.near = { x: parts[0]!, y: parts[1]!, z: parts[2]! }
  }

  for (const key of ['radius', 'limit', 'offset'] as const) {
    const value = text(key)
    if (value === undefined)
      continue
    const n = Number(value)
    if (!Number.isFinite(n) || n < 0)
      return `${key} must be a number, at least 0`
    result[key] = n
  }

  return result
}

/** Filter, sort by distance and page summaries */
export function queryEntities(summaries: EntitySummary[], query: EntityQuery = {}): EntityList {
  const type = query.type?.toLowerCase()
  const limit = Math.min(Math.max(0, query.limit ?? DEFAULT_ENTITY_LIMIT), MAX_ENTITY_LIMIT)
  const offset = Math.max(0, query.offset ?? 0)

  let matches = summaries.filter(entity => !type || entity.type.toLowerCase() === type || entity.sceneObject?.type.toLowerCase() === type)

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

export function vec(v: Vec3): Vec3 {
  return { x: v.x, y: v.y, z: v.z }
}

export function distance(a: Vec3, b: Vec3) {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** The value as plain JSON, or null when it can't be serialized (e.g. circular references) */
export function toJson(value: () => unknown): unknown {
  try {
    const json = JSON.stringify(value())
    return json === undefined ? null : JSON.parse(json)
  }
  catch {
    return null
  }
}
