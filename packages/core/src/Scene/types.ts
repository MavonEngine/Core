/**
 * The JSON format of a scene file (`scenes/<name>.json` in the project root).
 * Client and server load the same file; each side only builds the objects it has a factory for.
 */

export const SCENE_FORMAT_VERSION = 1

/** Directory in the project root (next to mavonengine.json) that holds the scene files */
export const SCENES_DIR = 'scenes'

/** Scene file names: letters, digits, `-` and `_` */
export const SCENE_NAME_RE = /^[\w-]+$/

export type SceneSide = 'client' | 'server'

export type Vec3Tuple = [number, number, number]

export interface SceneTransform {
  position: Vec3Tuple
  /** Euler angles in radians, XYZ order */
  rotation: Vec3Tuple
  scale: Vec3Tuple
}

export interface SceneObjectData {
  /** Unique within the scene. Used as the world entity key on both sides */
  id: string
  /** Key of a registered scene object type, see `registerSceneObject()` */
  type: string
  /** Shown in the editor */
  name?: string
  transform: SceneTransform
  /** Type specific data, written by the type's `serialize()` */
  props?: Record<string, unknown>
}

export interface SceneFog {
  color: string
  density: number
}

export interface SceneSettings {
  /** CSS color of the background */
  background?: string
  fog?: SceneFog
  [key: string]: unknown
}

export interface SceneData {
  version: number
  name: string
  settings?: SceneSettings
  objects: SceneObjectData[]
}

export function emptyTransform(): SceneTransform {
  return { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }
}

/**
 * Check that `value` looks like a scene file and fill in what may be left out.
 * Throws with a readable message when it doesn't.
 */
export function parseSceneData(value: unknown, fallbackName = 'untitled'): SceneData {
  if (!value || typeof value !== 'object')
    throw new Error('Scene must be a JSON object')

  const raw = value as Partial<SceneData>
  if (raw.version !== undefined && raw.version > SCENE_FORMAT_VERSION)
    throw new Error(`Scene format version ${raw.version} is newer than this engine supports (${SCENE_FORMAT_VERSION})`)

  if (raw.objects !== undefined && !Array.isArray(raw.objects))
    throw new Error('Scene "objects" must be an array')

  const objects = (raw.objects ?? []).map((object, index) => {
    if (!object || typeof object !== 'object' || typeof object.type !== 'string' || !object.type)
      throw new Error(`Scene object ${index} needs a "type"`)
    if (typeof object.id !== 'string' || !object.id)
      throw new Error(`Scene object ${index} (${object.type}) needs an "id"`)

    const transform = emptyTransform()
    for (const key of ['position', 'rotation', 'scale'] as const) {
      const v = object.transform?.[key]
      if (v !== undefined) {
        if (!Array.isArray(v) || v.length !== 3 || v.some(n => typeof n !== 'number'))
          throw new Error(`Scene object ${object.id}: transform.${key} must be [x, y, z]`)
        transform[key] = [v[0], v[1], v[2]]
      }
    }

    return { ...object, transform }
  })

  const ids = new Set<string>()
  for (const object of objects) {
    if (ids.has(object.id))
      throw new Error(`Scene object id "${object.id}" is used twice`)
    ids.add(object.id)
  }

  return {
    version: SCENE_FORMAT_VERSION,
    name: typeof raw.name === 'string' && raw.name ? raw.name : fallbackName,
    settings: raw.settings ?? {},
    objects,
  }
}
