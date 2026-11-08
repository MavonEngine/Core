import type { SceneData } from '../../src/Scene/types'
import { Object3D, Vector3 } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import GameScene from '../../src/Scene/GameScene'
import { clearSceneObjects, getSceneObject, registerSceneObject, registerSceneObjectResolver } from '../../src/Scene/SceneObjectRegistry'
import { parseSceneData } from '../../src/Scene/types'
import BaseWorld from '../../src/World/BaseWorld'
import GameObject from '../../src/World/GameObject'

class Crate extends GameObject {
  instance = new Object3D()
  weight: number
  destroyed = 0

  constructor(weight = 1) {
    super()
    this.weight = weight
  }

  update(): void {}

  destroy(): void {
    this.destroyed++
    super.destroy()
  }
}

/** Server side only, no Object3D */
class Spawner extends GameObject {
  update(): void {}
}

function sceneData(): SceneData {
  return {
    version: 1,
    name: 'test',
    settings: { background: '#000000' },
    objects: [
      { id: 'crate', type: 'Crate', name: 'Big crate', transform: { position: [1, 2, 3], rotation: [0, 1, 0], scale: [2, 2, 2] }, props: { weight: 5 } },
      { id: 'spawner', type: 'Spawner', transform: { position: [9, 0, 9], rotation: [0, 0, 0], scale: [1, 1, 1] }, props: { rate: 3 } },
      { id: 'unknown', type: 'NotRegistered', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, props: { keep: 'me' } },
    ],
  }
}

function registerTypes() {
  registerSceneObject<Crate>({
    type: 'Crate',
    client: data => new Crate(data.props?.weight as number),
    serialize: crate => ({ weight: crate.weight }),
  })
  registerSceneObject<Spawner>({
    type: 'Spawner',
    server: () => new Spawner(),
  })
}

afterEach(() => clearSceneObjects())

describe('parseSceneData', () => {
  it('fills in what may be left out', () => {
    const scene = parseSceneData({ objects: [{ id: 'a', type: 'Crate' }] }, 'level1')

    expect(scene).toEqual({
      version: 1,
      name: 'level1',
      settings: {},
      objects: [{ id: 'a', type: 'Crate', transform: { position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1] } }],
    })
  })

  it.each([
    [null, 'must be a JSON object'],
    [{ objects: {} }, 'must be an array'],
    [{ objects: [{ id: 'a' }] }, 'needs a "type"'],
    [{ objects: [{ type: 'Crate' }] }, 'needs an "id"'],
    [{ objects: [{ id: 'a', type: 'Crate' }, { id: 'a', type: 'Crate' }] }, 'used twice'],
    [{ objects: [{ id: 'a', type: 'Crate', transform: { position: [1, 2] } }] }, 'must be [x, y, z]'],
    [{ version: 99, objects: [] }, 'newer than this engine supports'],
  ])('rejects %j', (value, message) => {
    expect(() => parseSceneData(value)).toThrow(message)
  })
})

describe('registry', () => {
  it('merges registrations of the same type, so each side can add its factory', () => {
    const client = vi.fn()
    const server = vi.fn()
    registerSceneObject({ type: 'Thing', client, label: 'Thing' })
    registerSceneObject({ type: 'Thing', server })

    expect(getSceneObject('Thing')).toMatchObject({ client, server, label: 'Thing' })
  })

  it('keys plugin types by package', () => {
    registerSceneObject({ type: 'Tree', plugin: 'forest', client: vi.fn() })

    expect(getSceneObject('forest:Tree')).toBeDefined()
    expect(getSceneObject('Tree')).toBeUndefined()
  })

  it('asks resolvers for types that are not registered', () => {
    const remove = registerSceneObjectResolver(type => (type.startsWith('dyn:') ? { type, client: vi.fn() } : undefined))

    expect(getSceneObject('dyn:a')?.type).toBe('dyn:a')
    remove()
    expect(getSceneObject('dyn:a')).toBeUndefined()
  })
})

describe('gameScene', () => {
  it('builds only the objects this side has a factory for and adds them to the world by id', () => {
    registerTypes()
    const world = new BaseWorld()

    const client = new GameScene(sceneData(), { side: 'client', world }).instantiate()

    expect([...world.entities.items.keys()]).toEqual(['crate'])
    const crate = client.get('crate')!.object as Crate
    expect(crate).toBeInstanceOf(Crate)
    expect(crate.id).toBe('crate')
    expect(crate.weight).toBe(5)
    expect(crate.instance.position.toArray()).toEqual([1, 2, 3])
    expect(crate.instance.rotation.y).toBe(1)
    expect(crate.instance.scale.toArray()).toEqual([2, 2, 2])
    expect(crate.instance.name).toBe('Big crate')
    expect(crate.instance.userData.sceneObjectId).toBe('crate')
    expect(client.get('spawner')!.object).toBeUndefined()

    const serverWorld = new BaseWorld()
    new GameScene(sceneData(), { side: 'server', world: serverWorld }).instantiate()
    expect([...serverWorld.entities.items.keys()]).toEqual(['spawner'])
    expect(serverWorld.entities.items.get('spawner')!.position.toArray()).toEqual([9, 0, 9])
  })

  it('saves what it loaded, keeping the objects it did not build untouched', () => {
    registerTypes()
    const scene = new GameScene(sceneData(), { side: 'client', world: new BaseWorld() }).instantiate()

    expect(scene.serialize()).toEqual(sceneData())
    expect(scene.isDirty()).toBe(false)
  })

  it('is not dirty when only the key order of the props differs from the file', () => {
    registerSceneObject<Crate>({
      type: 'Crate',
      client: data => new Crate(data.props?.weight as number),
      serialize: crate => ({ label: 'x', weight: crate.weight }),
    })
    const data = sceneData()
    data.objects[0].props = { weight: 5, label: 'x' }
    const scene = new GameScene(data, { side: 'client', world: new BaseWorld() }).instantiate()

    expect(scene.isDirty()).toBe(false)
  })

  it('saves the current transform and props of the objects', () => {
    registerTypes()
    const scene = new GameScene(sceneData(), { side: 'client', world: new BaseWorld() }).instantiate()
    const crate = scene.get('crate')!.object as Crate

    crate.instance.position.set(4, 5, 6.0000001)
    crate.weight = 7

    expect(scene.isDirty()).toBe(true)
    const saved = scene.serialize().objects[0]
    expect(saved.transform.position).toEqual([4, 5, 6])
    expect(saved.props).toEqual({ weight: 7 })

    scene.markSaved()
    expect(scene.isDirty()).toBe(false)
  })

  it('creates and removes objects', () => {
    registerTypes()
    const world = new BaseWorld()
    const scene = new GameScene(sceneData(), { side: 'client', world }).instantiate()

    const entry = scene.create('Crate', { transform: { position: [0, 1, 0], rotation: [0, 0, 0], scale: [1, 1, 1] }, props: { weight: 2 } })!
    expect(entry.data.id).toBe('crate_1')
    expect(world.entities.items.get('crate_1')).toBe(entry.object)

    const crate = entry.object as Crate
    scene.remove('crate_1')
    expect(world.entities.items.has('crate_1')).toBe(false)
    expect(crate.destroyed).toBe(1)
    expect(scene.serialize().objects.map(o => o.id)).toEqual(['crate', 'spawner', 'unknown'])
  })

  it('returns undefined when this side cannot build the type', () => {
    registerTypes()
    const scene = new GameScene(sceneData(), { side: 'client', world: new BaseWorld() })

    expect(scene.create('Spawner')).toBeUndefined()
    expect(scene.create('NotRegistered')).toBeUndefined()
  })

  it('drops objects that were destroyed elsewhere, e.g. deleted in the editor', () => {
    registerTypes()
    const scene = new GameScene(sceneData(), { side: 'client', world: new BaseWorld() }).instantiate()

    scene.get('crate')!.object!.destroy()

    expect(scene.serialize().objects.map(o => o.id)).toEqual(['spawner', 'unknown'])
  })

  it('adopts an existing object', () => {
    registerTypes()
    const world = new BaseWorld()
    const scene = new GameScene({ objects: [] }, { side: 'client', world })
    const crate = new Crate(3)
    crate.instance.position.set(1, 0, 0)
    world.add({ temp: crate })

    const entry = scene.adopt(crate, 'Crate')

    expect(world.entities.items.has('temp')).toBe(false)
    expect(world.entities.items.get(entry.data.id)).toBe(crate)
    expect(scene.serialize().objects[0]).toMatchObject({ type: 'Crate', transform: { position: [1, 0, 0] }, props: { weight: 3 } })
  })

  it('rebuilds props changes and keeps transforms', () => {
    registerTypes()
    const scene = new GameScene(sceneData(), { side: 'client', world: new BaseWorld() }).instantiate()
    const before = scene.get('crate')!.object as Crate
    before.instance.position.set(7, 7, 7)

    scene.setProps('crate', { weight: 9 })

    const after = scene.get('crate')!.object as Crate
    expect(after).not.toBe(before)
    expect(before.destroyed).toBe(1)
    expect(after.weight).toBe(9)
    expect(after.instance.position.toArray()).toEqual([7, 7, 7])
  })

  it('edits the props of objects it does not build', () => {
    registerTypes()
    const scene = new GameScene(sceneData(), { side: 'client', world: new BaseWorld() }).instantiate()

    scene.setProps('spawner', { rate: 10 })

    expect(scene.serialize().objects[1].props).toEqual({ rate: 10 })
  })

  it('logs and skips objects whose factory throws', () => {
    registerSceneObject({
      type: 'Crate',
      client: () => {
        throw new Error('boom')
      },
    })
    const world = new BaseWorld()

    const scene = new GameScene(sceneData(), { side: 'client', world }).instantiate()

    expect(world.entities.items.size).toBe(0)
    expect(scene.serialize().objects).toHaveLength(3)
  })

  it('destroys its objects without the world destroying them a second time', () => {
    registerTypes()
    const world = new BaseWorld()
    const scene = new GameScene(sceneData(), { side: 'client', world }).instantiate()
    const crate = scene.get('crate')!.object as Crate

    scene.destroy()
    world.update(0.1)

    expect(world.entities.items.size).toBe(0)
    expect(crate.destroyed).toBe(1)
  })

  it('uses the GameObject transform when there is no Object3D', () => {
    registerSceneObject({ type: 'Spawner', client: () => new Spawner() })
    const scene = new GameScene(sceneData(), { side: 'client', world: new BaseWorld() }).instantiate()

    scene.get('spawner')!.object!.position.copy(new Vector3(1, 1, 1))

    expect(scene.serialize().objects[1].transform.position).toEqual([1, 1, 1])
  })

  it('finds the entry of an Object3D from any of its children', () => {
    registerTypes()
    const scene = new GameScene(sceneData(), { side: 'client', world: new BaseWorld() }).instantiate()
    const crate = scene.get('crate')!.object as Crate
    const child = new Object3D()
    crate.instance.add(child)

    expect(scene.entryOfObject3D(child)?.data.id).toBe('crate')
    expect(scene.entryOfObject3D(new Object3D())).toBeUndefined()
  })
})
