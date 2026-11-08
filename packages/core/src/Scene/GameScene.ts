import type BaseWorld from '../World/BaseWorld'
import type GameObject from '../World/GameObject'
import type { SceneObjectContext, SceneObjectDefinition } from './SceneObjectRegistry'
import type { SceneData, SceneObjectData, SceneSettings, SceneSide, SceneTransform, Vec3Tuple } from './types'
import { Object3D } from 'three'
import BaseGame from '../BaseGame'
import EventEmitter from '../Utils/EventEmitter'
import { getSceneObject } from './SceneObjectRegistry'
import { emptyTransform, parseSceneData, SCENE_FORMAT_VERSION } from './types'

export interface SceneEntry {
  /** The data as loaded, or as last captured from the object */
  data: SceneObjectData
  /** The object built for this side. Unset when this side has no factory for the type */
  object?: GameObject
}

export interface GameSceneOptions {
  side: SceneSide
  world: BaseWorld
  /** File name without `.json`, used to save the scene back */
  source?: string
}

const ID_CHARS_RE = /[^\w-]+/g

/**
 * A loaded scene: the objects of a scene file added to the world, plus the data of the ones this side doesn't build.
 * `serialize()` turns it back into the file's JSON with the objects' current transforms and props.
 *
 * Events: `objectAdded` ({ entry }), `objectRemoved` ({ id }), `settingsChanged` (settings), `changed`
 */
export default class GameScene extends EventEmitter {
  readonly side: SceneSide
  readonly world: BaseWorld
  source?: string
  name: string
  settings: SceneSettings

  private entries = new Map<string, SceneEntry>()
  private savedSnapshot: string
  private instantiated = false

  constructor(data: SceneData | unknown, options: GameSceneOptions) {
    super()

    const scene = parseSceneData(data, options.source)

    this.side = options.side
    this.world = options.world
    this.source = options.source
    this.name = scene.name
    this.settings = scene.settings ?? {}

    for (const object of scene.objects)
      this.entries.set(object.id, { data: object })

    this.savedSnapshot = stableStringify(scene)
  }

  private get logger() {
    return BaseGame.instance()?.logger
  }

  /**
   * Build the objects this side has a factory for and add them to the world
   */
  instantiate(): this {
    this.instantiated = true
    this.entries.forEach(entry => this.build(entry))
    return this
  }

  get isInstantiated() {
    return this.instantiated
  }

  /** Every entry in file order, including those this side doesn't build */
  getEntries(): SceneEntry[] {
    return [...this.entries.values()]
  }

  get(id: string): SceneEntry | undefined {
    return this.entries.get(id)
  }

  /** The entry an object belongs to, or undefined for objects that aren't part of the scene (players, network entities) */
  entryOf(object: GameObject): SceneEntry | undefined {
    const entry = this.entries.get(object.id)
    return entry?.object === object ? entry : undefined
  }

  /** The entry an Object3D belongs to, by the id the scene tags it with */
  entryOfObject3D(object: Object3D | null | undefined): SceneEntry | undefined {
    for (let o = object; o; o = o.parent) {
      const id = o.userData.sceneObjectId as string | undefined
      if (id)
        return this.entries.get(id)
    }
    return undefined
  }

  /**
   * Create an object of a registered type and add it to the scene, e.g. when it is placed in the editor.
   * Returns undefined when this side can't build the type.
   */
  create(type: string, data: Partial<Omit<SceneObjectData, 'type'>> = {}): SceneEntry | undefined {
    const entry: SceneEntry = {
      data: {
        id: data.id && !this.entries.has(data.id) ? data.id : this.uniqueId(type),
        type,
        name: data.name,
        transform: { ...emptyTransform(), ...data.transform },
        props: data.props,
      },
    }

    if (!this.build(entry, true))
      return undefined

    this.changed()
    return entry
  }

  /**
   * Make an object that already exists part of the scene, so it is saved with it.
   * `type` must be registered for the scene to load it again.
   */
  adopt(object: GameObject, type: string, name?: string): SceneEntry {
    const id = this.entries.has(object.id) || this.world.entities.items.has(object.id) ? this.uniqueId(type) : object.id
    const existingKey = [...this.world.entities.items].find(([, o]) => o === object)?.[0]
    if (existingKey !== undefined && existingKey !== id)
      this.world.entities.items.delete(existingKey)

    const entry: SceneEntry = { data: { id, type, name, transform: emptyTransform() }, object }
    object.id = id
    entry.data = this.capture(entry)
    this.attach(entry, object)

    this.changed()
    return entry
  }

  /** Remove an object from the scene and destroy it */
  remove(id: string): void {
    const entry = this.entries.get(id)
    if (!entry)
      return

    this.release(entry)
    this.entries.delete(id)
    this.trigger('objectRemoved', { id })
    this.changed()
  }

  /**
   * Change the props of an entry. Built objects are rebuilt so they pick them up
   */
  setProps(id: string, props: Record<string, unknown>): void {
    const entry = this.entries.get(id)
    if (!entry)
      return

    // Released first: that captures the object's current data, which the new props then go on top of
    const built = !!entry.object
    this.release(entry)
    entry.data = { ...entry.data, props: { ...entry.data.props, ...props } }
    if (built)
      this.build(entry)
    this.changed()
  }

  setName(id: string, name: string | undefined): void {
    const entry = this.entries.get(id)
    if (!entry)
      return
    entry.data = { ...entry.data, name: name || undefined }
    const target = entry.object && this.transformTarget(entry.object)
    if (target)
      target.name = name || entry.data.type
    this.changed()
  }

  setSettings(settings: SceneSettings): void {
    this.settings = { ...this.settings, ...settings }
    this.trigger('settingsChanged', this.settings)
    this.changed()
  }

  /**
   * The scene as JSON, with the current transforms and props of the objects. Objects that were destroyed are left out.
   */
  serialize(): SceneData {
    for (const [id, entry] of this.entries) {
      if (entry.object?.garbageCollect) {
        this.entries.delete(id)
        continue
      }
      entry.data = this.capture(entry)
    }

    return {
      version: SCENE_FORMAT_VERSION,
      name: this.name,
      settings: this.settings,
      objects: Array.from(this.entries.values(), entry => entry.data),
    }
  }

  /** Changed since it was loaded or last marked saved */
  isDirty(): boolean {
    return stableStringify(this.serialize()) !== this.savedSnapshot
  }

  markSaved(data: SceneData = this.serialize()): void {
    this.savedSnapshot = stableStringify(data)
    this.trigger('saved', data)
  }

  /**
   * Rebuild every object from its current data, e.g. so the editor can attach its helpers
   */
  rebuild(): void {
    this.serialize()
    this.entries.forEach(entry => this.release(entry))
    this.entries.forEach(entry => this.build(entry))
    this.trigger('changed')
  }

  /** Destroy the built objects and remove them from the world */
  destroy(): void {
    this.entries.forEach(entry => this.release(entry))
    this.instantiated = false
    this.trigger('destroyed')
  }

  private changed() {
    this.trigger('changed')
  }

  private build(entry: SceneEntry, throwOnError = false): boolean {
    const definition = getSceneObject(entry.data.type)
    const factory = definition?.[this.side]
    if (!factory)
      return false

    const ctx: SceneObjectContext = { scene: this, side: this.side }
    let object: GameObject | null | void
    try {
      object = factory(structuredClone(entry.data), ctx)
    }
    catch (err) {
      if (throwOnError)
        throw err
      this.logger?.error(`Scene ${this.name}: could not build ${entry.data.type} ${entry.data.id}: ${(err as Error).message}`)
      return false
    }

    if (!object)
      return false

    object.id = entry.data.id
    this.applyTransform(object, entry.data.transform, definition)
    this.attach(entry, object)
    return true
  }

  private attach(entry: SceneEntry, object: GameObject) {
    entry.object = object
    this.entries.set(entry.data.id, entry)

    const target = this.transformTarget(object)
    if (target) {
      target.userData.sceneObjectId = entry.data.id
      target.name = entry.data.name ?? entry.data.type
    }

    this.world.add({ [entry.data.id]: object })
    this.trigger('objectAdded', { entry })
  }

  private release(entry: SceneEntry) {
    const object = entry.object
    if (!object)
      return

    entry.data = this.capture(entry)
    entry.object = undefined

    if (this.world.entities.items.get(entry.data.id) === object)
      this.world.entities.items.delete(entry.data.id)
    if (!object.garbageCollect)
      object.destroy()
  }

  private capture(entry: SceneEntry): SceneObjectData {
    const object = entry.object
    if (!object || object.garbageCollect)
      return entry.data

    const definition = getSceneObject(entry.data.type)
    const target = this.transformTarget(object, definition)
    const source = target ?? object
    const transform: SceneTransform = {
      position: round(source.position.toArray() as Vec3Tuple),
      rotation: round(target
        ? [target.rotation.x, target.rotation.y, target.rotation.z]
        : object.rotation.toArray() as Vec3Tuple),
      scale: round(source.scale.toArray() as Vec3Tuple),
    }

    const props = definition?.serialize ? definition.serialize(object) : entry.data.props
    return {
      id: entry.data.id,
      type: entry.data.type,
      ...(entry.data.name ? { name: entry.data.name } : {}),
      transform,
      ...(props && Object.keys(props).length ? { props } : {}),
    }
  }

  private applyTransform(object: GameObject, transform: SceneTransform, definition?: SceneObjectDefinition) {
    object.position.fromArray(transform.position)
    object.rotation.fromArray(transform.rotation)
    object.scale.fromArray(transform.scale)

    const target = this.transformTarget(object, definition)
    if (target) {
      target.position.fromArray(transform.position)
      target.rotation.set(...transform.rotation)
      target.scale.fromArray(transform.scale)
    }
  }

  private transformTarget(object: GameObject, definition = getSceneObject(this.entries.get(object.id)?.data.type ?? '')): Object3D | undefined {
    if (definition?.transformTarget)
      return definition.transformTarget(object)
    const instance = (object as { instance?: unknown }).instance
    return instance instanceof Object3D ? instance : undefined
  }

  private uniqueId(type: string): string {
    const base = (type.split(':').pop() ?? 'object').replace(ID_CHARS_RE, '_').toLowerCase() || 'object'
    for (let i = 1; ; i++) {
      const id = `${base}_${i}`
      if (!this.entries.has(id) && !this.world.entities.items.has(id))
        return id
    }
  }
}

/** JSON with object keys sorted, so the same data in another key order compares equal */
function stableStringify(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) => v && typeof v === 'object' && !Array.isArray(v)
    ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
    : v)
}

/** Keep the files readable: float noise from transforms is cut at 6 decimals */
function round(v: Vec3Tuple): Vec3Tuple {
  return v.map(n => Math.round(n * 1e6) / 1e6 + 0) as Vec3Tuple
}
