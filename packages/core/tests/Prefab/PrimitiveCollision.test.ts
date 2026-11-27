import type { World } from '@dimforge/rapier3d-compat'
import RAPIER from '@dimforge/rapier3d-compat'
import { Vector3 } from 'three'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import BaseGame from '../../src/BaseGame'
import Game from '../../src/Game'
import { BoxPrimitive, PRIMITIVE_REGISTRY } from '../../src/Prefab/Primitives/index'
import { PrimitiveBody, primitiveOptionsFromProps, registerPrimitiveServerObjects } from '../../src/Scene/primitiveSceneObjects'
import { getSceneObject } from '../../src/Scene/SceneObjectRegistry'

vi.mock('../../src/Game', () => ({
  default: {
    instance: vi.fn(),
  },
}))

let world: World

beforeAll(async () => {
  await RAPIER.init()
})

beforeEach(() => {
  world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
  vi.mocked(Game.instance).mockReturnValue({
    scene: {
      add: vi.fn(),
      remove: vi.fn(),
    },
    physicsWorld: world,
  } as any)
})

/** The height of the first surface below (x, 50, z), or null */
function surfaceAt(x: number, z: number): number | null {
  world.step()
  const hit = world.castRay(new RAPIER.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 }), 100, true)
  return hit
    ? 50 - hit.timeOfImpact
    : null
}

describe('primitive collision on the client', () => {
  it('adds a collider on its first update, where the mesh is', () => {
    const box = new BoxPrimitive(new Vector3(3, 0, 0), undefined, { pivot: 'base' })
    expect(box.collider).toBeUndefined()

    box.update(0)

    expect(box.collider).toBeDefined()
    expect(surfaceAt(3, 0)).toBeCloseTo(1)
    expect(surfaceAt(0, 0)).toBeNull()
  })

  it('follows moves, scale and geometry changes', () => {
    const box = new BoxPrimitive(new Vector3(), undefined, { pivot: 'base' })
    box.update(0)

    box.instance.position.set(5, 0, 0)
    box.update(0)
    expect(surfaceAt(5, 0)).toBeCloseTo(1)
    expect(surfaceAt(0, 0)).toBeNull()

    box.setParam('height', 3)
    box.update(0)
    expect(surfaceAt(5, 0)).toBeCloseTo(3)

    box.instance.scale.set(1, 2, 1)
    box.update(0)
    expect(surfaceAt(5, 0)).toBeCloseTo(6)
    expect(world.colliders.len()).toBe(1)
  })

  it('removes the collider when collision is turned off or the primitive is destroyed', () => {
    const box = new BoxPrimitive(new Vector3())
    box.update(0)
    box.setCollision(false)
    expect(world.colliders.len()).toBe(0)

    box.setCollision(true)
    expect(world.colliders.len()).toBe(1)
    box.destroy()
    expect(world.colliders.len()).toBe(0)
  })

  it('never collides as lines, and does nothing without a physics world', () => {
    const edges = new PRIMITIVE_REGISTRY.Edges(new Vector3())
    edges.update(0)
    expect(edges.collision).toBe(false)
    expect(world.colliders.len()).toBe(0)

    vi.mocked(Game.instance).mockReturnValue({
      scene: {
        add: vi.fn(),
        remove: vi.fn(),
      },
    } as any)
    const box = new BoxPrimitive(new Vector3())
    box.update(0)
    expect(box.collider).toBeUndefined()
  })
})

describe('primitive collision on the server', () => {
  beforeEach(() => {
    vi.spyOn(BaseGame, 'instance').mockReturnValue({ physicsWorld: world } as any)
    registerPrimitiveServerObjects()
  })

  function data(type: string, props: Record<string, unknown> = {}) {
    return {
      id: 'thing',
      type,
      transform: {
        position: [2, 0, 0] as [number, number, number],
        rotation: [0, 0, 0] as [number, number, number],
        scale: [1, 2, 1] as [number, number, number],
      },
      props,
    }
  }

  it('builds the same collider as the client from the saved props', () => {
    const server = getSceneObject('Primitive:Box')!.server!
    const body = server(data('Primitive:Box', { height: 2, pivot: 'base' }), {} as any)

    expect(body).toBeInstanceOf(PrimitiveBody)
    expect(surfaceAt(2, 0)).toBeCloseTo(4)

    ;(body as PrimitiveBody).destroy()
    expect(world.colliders.len()).toBe(0)
  })

  it('skips primitives without collision', () => {
    const server = (type: string) => getSceneObject(type)!.server!
    expect(server('Primitive:Box')(data('Primitive:Box', { collision: false }), {} as any)).toBeUndefined()
    expect(server('Primitive:Wireframe')(data('Primitive:Wireframe'), {} as any)).toBeUndefined()
    expect(world.colliders.len()).toBe(0)
  })
})

describe('primitiveOptionsFromProps', () => {
  it('defaults to a centered pivot with collision', () => {
    expect(primitiveOptionsFromProps()).toEqual({ pivot: 'center', collision: true })
    expect(primitiveOptionsFromProps({ pivot: 'base', collision: false })).toEqual({ pivot: 'base', collision: false })
  })
})
