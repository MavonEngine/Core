import type BaseGame from '../../../../src/BaseGame'
import { Vector3 } from 'three'
import { afterEach, describe, expect, it } from 'vitest'
import WorldInspector, { devEndpointsEnabled } from '../../../../src/Networking/Server/Stats/WorldInspector'
import GameScene from '../../../../src/Scene/GameScene'
import { clearSceneObjects, registerSceneObject } from '../../../../src/Scene/SceneObjectRegistry'
import BaseWorld from '../../../../src/World/BaseWorld'
import GameObject from '../../../../src/World/GameObject'

class Rock extends GameObject {
  update(): void {}
}

class Circular extends GameObject {
  update(): void {}

  serialize() {
    const self: Record<string, unknown> = {}
    self.self = self
    return self as any
  }
}

function inspect(options: { scene?: boolean, file?: string, watched?: boolean } = {}) {
  const world = new BaseWorld()
  const game = { world } as unknown as BaseGame

  if (options.scene) {
    registerSceneObject({ type: 'Spawner', server: () => new Rock(), plugin: '@acme/spawners' })
    registerSceneObject({ type: 'Tree', client: () => new Rock() })
    game.activeScene = new GameScene({
      version: 1,
      name: 'Forest',
      objects: [
        { id: 'spawn', type: '@acme/spawners:Spawner', name: 'North spawn', transform: { position: [5, 0, 0] } },
        { id: 'tree', type: 'Tree' },
        { id: 'ghost', type: 'Missing' },
      ],
    }, { side: 'server', world, source: 'forest' }).instantiate()
  }

  const inspector = new WorldInspector({ game, activeSceneFile: options.file, sceneWatched: options.watched ?? false })
  return { world, game, inspector }
}

afterEach(() => clearSceneObjects())

describe('devEndpointsEnabled', () => {
  it('is off only in production', () => {
    expect(devEndpointsEnabled({})).toBe(true)
    expect(devEndpointsEnabled({ NODE_ENV: 'development' })).toBe(true)
    expect(devEndpointsEnabled({ NODE_ENV: 'test' })).toBe(true)
    expect(devEndpointsEnabled({ NODE_ENV: 'production' })).toBe(false)
  })
})

describe('worldInspector', () => {
  it('has no scene until one is loaded', () => {
    expect(inspect().inspector.scene()).toBeNull()
  })

  it('describes the active scene and which objects the server built', () => {
    const { inspector } = inspect({ scene: true, file: '/game/scenes/forest.json', watched: true })

    const scene = inspector.scene()!
    expect(scene).toMatchObject({ name: 'Forest', source: 'forest', file: '/game/scenes/forest.json', watching: true, dirty: false })
    expect(scene.objects.map(o => [o.id, o.built, o.plugin])).toEqual([
      ['spawn', true, '@acme/spawners'],
      ['tree', false, null],
      ['ghost', false, undefined],
    ])
    expect(scene.objects[0]!.transform.position).toEqual([5, 0, 0])
  })

  it('reports a scene with moved objects as dirty', () => {
    const { inspector, world } = inspect({ scene: true })

    world.entities.items.get('spawn')!.position.set(1, 1, 1)

    const scene = inspector.scene()!
    expect(scene.dirty).toBe(true)
    expect(scene.objects[0]!.transform.position).toEqual([1, 1, 1])
  })

  it('lists entities with their scene objects', () => {
    const { inspector, world } = inspect({ scene: true })
    world.add({ rock: new Rock('rock', new Vector3(1, 2, 3)) })

    const { total, entities } = inspector.entities()
    expect(total).toBe(2)
    expect(entities.find(e => e.id === 'spawn')).toMatchObject({
      type: 'Rock',
      position: { x: 5, y: 0, z: 0 },
      networked: false,
      player: false,
      sceneObject: { type: '@acme/spawners:Spawner', name: 'North spawn' },
    })
    expect(entities.find(e => e.id === 'rock')!.sceneObject).toBeNull()
  })

  it('filters by type, case-insensitively, on the class or the scene object type', () => {
    const { inspector, world } = inspect({ scene: true })
    world.add({ c: new Circular('c') })

    expect(inspector.entities({ type: 'circular' }).entities.map(e => e.id)).toEqual(['c'])
    expect(inspector.entities({ type: '@acme/spawners:spawner' }).entities.map(e => e.id)).toEqual(['spawn'])
  })

  it('sorts by distance and cuts off at the radius', () => {
    const { inspector, world } = inspect()
    world.add({
      far: new Rock('far', new Vector3(100, 0, 0)),
      near: new Rock('near', new Vector3(1, 0, 0)),
      mid: new Rock('mid', new Vector3(0, 5, 0)),
    })

    expect(inspector.entities({ near: { x: 0, y: 0, z: 0 } }).entities.map(e => e.id)).toEqual(['near', 'mid', 'far'])
    expect(inspector.entities({ near: { x: 0, y: 0, z: 0 }, radius: 10 }).entities.map(e => e.id)).toEqual(['near', 'mid'])
  })

  it('pages with limit and offset, and caps the limit', () => {
    const { inspector, world } = inspect()
    for (let i = 0; i < 600; i++)
      world.add({ [`r${i}`]: new Rock(`r${i}`) })

    expect(inspector.entities().entities).toHaveLength(50)
    expect(inspector.entities({ limit: 10_000 }).entities).toHaveLength(500)

    const page = inspector.entities({ limit: 2, offset: 10 })
    expect(page.total).toBe(600)
    expect(page.entities.map(e => e.id)).toEqual(['r10', 'r11'])
  })

  it('returns one entity with its serialized state', () => {
    const { inspector, world } = inspect()
    world.add({ rock: new Rock('rock', new Vector3(1, 2, 3)), c: new Circular('c') })

    expect(inspector.entity('rock')!.serialized).toMatchObject({ id: 'rock', position: { x: 1, y: 2, z: 3 } })
    expect(inspector.entity('c')!.serialized).toBeNull()
    expect(inspector.entity('nope')).toBeNull()
  })
})
