import type { Object3D } from 'three'
import type GameObject from '../World/GameObject'
import type GameScene from './GameScene'
import type { SceneObjectData, SceneSide } from './types'

export interface SceneObjectContext {
  scene: GameScene
  side: SceneSide
}

export type SceneObjectFactory<T extends GameObject = GameObject> = (data: SceneObjectData, ctx: SceneObjectContext) => T | null | void

/**
 * How a type of scene object is built and saved.
 *
 * Give `client` for what is rendered, `server` for what the server simulates (colliders, game logic; no rendering).
 * A side without a factory skips the object but keeps its data, so saving never drops it.
 * Register the same type once per side and the definitions are merged, e.g. the client registers `client`
 * and `serialize` while the server registers `server`.
 */
export interface SceneObjectDefinition<T extends GameObject = GameObject> {
  type: string
  /** Shown in the editor. Defaults to `type` */
  label?: string
  /** npm package of the plugin that registered it, unset for the project's and built-in types */
  plugin?: string
  client?: SceneObjectFactory<T>
  server?: SceneObjectFactory<T>
  /**
   * The props to save for `object`. The transform is saved for you.
   * Without it the props the object was loaded with are kept as they were.
   */
  serialize?(object: T): Record<string, unknown> | undefined
  /**
   * The Object3D the editor moves, which the transform is read from and applied to.
   * Defaults to `object.instance` when that is an Object3D, otherwise the GameObject's own position / rotation / scale.
   */
  transformTarget?(object: T): Object3D | undefined
}

/** Resolves types that aren't registered, e.g. `prefab:<key>` */
export type SceneObjectResolver = (type: string) => SceneObjectDefinition | undefined

const registry = new Map<string, SceneObjectDefinition>()
const resolvers: SceneObjectResolver[] = []

export function sceneObjectKey(definition: Pick<SceneObjectDefinition, 'type' | 'plugin'>): string {
  return definition.plugin ? `${definition.plugin}:${definition.type}` : definition.type
}

/**
 * Make a scene object type loadable. Registering a type that exists merges the two, the newer fields win.
 */
export function registerSceneObject<T extends GameObject>(definition: SceneObjectDefinition<T>): void {
  const key = sceneObjectKey(definition)
  const existing = registry.get(key)
  registry.set(key, { ...existing, ...(definition as unknown as SceneObjectDefinition), type: definition.type })
}

export function unregisterSceneObject(key: string): void {
  registry.delete(key)
}

export function registerSceneObjectResolver(resolver: SceneObjectResolver): () => void {
  resolvers.push(resolver)
  return () => {
    const index = resolvers.indexOf(resolver)
    if (index >= 0)
      resolvers.splice(index, 1)
  }
}

export function getSceneObject(key: string): SceneObjectDefinition | undefined {
  const registered = registry.get(key)
  if (registered)
    return registered

  for (const resolve of resolvers) {
    const resolved = resolve(key)
    if (resolved)
      return resolved
  }

  return undefined
}

export function getSceneObjects(): (SceneObjectDefinition & { key: string })[] {
  return Array.from(registry.entries(), ([key, definition]) => ({ ...definition, key }))
}

/** For tests */
export function clearSceneObjects(): void {
  registry.clear()
  resolvers.length = 0
}
