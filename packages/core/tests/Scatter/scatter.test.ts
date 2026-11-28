import type { World } from '@dimforge/rapier3d-compat'
import RAPIER from '@dimforge/rapier3d-compat'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import BaseGame from '../../src/BaseGame'
import Game from '../../src/Game'
import { parseScatterBrush, pickEntry, placeInstance, targetCount } from '../../src/Scatter/scatterBrush'
import { buildScatterColliders, colliderFromBounds, instanceCount, pushInstance, readInstance, SCATTER_TYPE, scatterPropsFrom, serializeScatterProps } from '../../src/Scatter/scatterData'
import { getSceneObject } from '../../src/Scene/SceneObjectRegistry'
import { seededRandom } from '../../src/Terrain/codec'
import { Heightmap, TERRAIN_TYPE } from '../../src/Terrain/terrainData'
import { registerTerrainServerObjects, ScatterBody, TerrainBody } from '../../src/Terrain/terrainSceneObjects'

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
})

function surfaceAt(x: number, z: number): number | null {
  world.step()
  const hit = world.castRay(new RAPIER.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 }), 100, true)
  return hit
    ? 50 - hit.timeOfImpact
    : null
}

function layerWith(positions: [number, number, number][], collision = true) {
  const group = {
    asset: 'rock',
    collision,
    collider: colliderFromBounds('box', 1, [-0.5, 0, -0.5], [0.5, 2, 0.5]),
    castShadow: true,
    receiveShadow: true,
    instances: [] as number[],
  }
  for (const p of positions) {
    pushInstance(group, {
      position: new Vector3(...p),
      quaternion: new Quaternion(),
      scale: new Vector3(1, 1, 1),
    })
  }
  return {
    groups: [group],
    collision: true,
  }
}

describe('scatter data', () => {
  it('round trips through the props, dropping empty groups', () => {
    const props = layerWith([
      [1, 0, 2],
      [3, 0, 4],
    ])
    props.groups.push({ ...props.groups[0], asset: 'empty', instances: [] })
    const saved = serializeScatterProps(props)
    expect((saved.groups as unknown[]).length).toBe(1)

    const loaded = scatterPropsFrom(JSON.parse(JSON.stringify(saved)))
    expect(instanceCount(loaded.groups[0])).toBe(2)
    expect(readInstance(loaded.groups[0], 1).position.toArray()).toEqual([3, 0, 4])
    expect(loaded.groups[0].collider?.shape).toBe('box')
  })

  it('keeps a group with broken instances, without them', () => {
    const loaded = scatterPropsFrom({
      groups: [
        { asset: 'a', instances: 'broken' },
        { nope: true },
      ],
    })
    expect(loaded.groups).toHaveLength(1)
    expect(loaded.groups[0].instances).toEqual([])
  })

  it('fits colliders to the bounds', () => {
    const trunk = colliderFromBounds('cylinder', 0.2, [-2, 0, -1], [2, 10, 1])
    expect(trunk.halfSize).toEqual([0.2, 5, 0.2])
    expect(trunk.center).toEqual([0, 5, 0])
  })

  it('builds a collider per instance, placed by the layer, unless collision is off', () => {
    const props = layerWith([
      [5, 0, 0],
    ])
    const colliders = buildScatterColliders(world, props, new Matrix4().makeTranslation(0, 1, 0))
    expect(colliders).toHaveLength(1)
    expect(surfaceAt(5, 0)).toBeCloseTo(3)
    expect(surfaceAt(0, 0)).toBeNull()

    expect(buildScatterColliders(world, { ...props, collision: false })).toHaveLength(0)
    expect(buildScatterColliders(world, layerWith([
      [0, 0, 0],
    ], false))).toHaveLength(0)
  })
})

describe('scatter brush', () => {
  it('parses with defaults and drops entries without an asset', () => {
    const brush = parseScatterBrush({
      name: 'forest',
      entries: [
        {
          asset: 'fern',
          scale: { min: 2, max: 1 },
        },
        { density: 3 },
      ],
    })
    expect(brush.entries).toHaveLength(1)
    expect(brush.entries[0].scale).toEqual({ min: 1, max: 2, mode: 'uniform' })
    expect(brush.entries[0].collision).toBe(true)
    expect(() => parseScatterBrush({ kind: 'other' })).toThrow()
  })

  it('picks entries by weight', () => {
    const [a, b] = parseScatterBrush({
      entries: [
        { asset: 'a', weight: 0 },
        { asset: 'b', weight: 1 },
      ],
    }).entries
    const random = seededRandom(1)
    for (let i = 0; i < 20; i++)
      expect(pickEntry([a, b], random)).toBe(b)
    expect(pickEntry([a], random)).toBeUndefined()
  })

  it('leaves out spots the filters reject', () => {
    const [entry] = parseScatterBrush({
      entries: [
        {
          asset: 'a',
          slope: [0, 30],
          height: [0, 10],
          layerFilter: { graph: 'grass', minWeight: 0.5 },
        },
      ],
    }).entries
    const flat = {
      point: new Vector3(0, 1, 0),
      normal: new Vector3(0, 1, 0),
      layerWeight: () => 1,
    }
    expect(placeInstance(entry, flat, seededRandom(1))).toBeDefined()
    expect(placeInstance(entry, {
      ...flat,
      normal: new Vector3(1, 1, 0).normalize(),
    }, seededRandom(1))).toBeUndefined()
    expect(placeInstance(entry, {
      ...flat,
      point: new Vector3(0, 20, 0),
    }, seededRandom(1))).toBeUndefined()
    expect(placeInstance(entry, {
      ...flat,
      layerWeight: () => 0.2,
    }, seededRandom(1))).toBeUndefined()
    expect(placeInstance(entry, { point: flat.point, normal: flat.normal }, seededRandom(1))).toBeUndefined()
  })

  it('scales, aligns and offsets', () => {
    const [entry] = parseScatterBrush({
      entries: [
        {
          asset: 'a',
          scale: { min: 2, max: 2 },
          alignToNormal: 1,
          zOffset: [-1, -1],
          randomYaw: false,
          slope: [0, 90],
        },
      ],
    }).entries
    const normal = new Vector3(1, 1, 0).normalize()
    const placed = placeInstance(entry, {
      point: new Vector3(),
      normal,
    }, seededRandom(3))!
    expect(placed.scale.toArray()).toEqual([2, 2, 2])
    expect(new Vector3(0, 1, 0).applyQuaternion(placed.quaternion).distanceTo(normal)).toBeLessThan(1e-6)
    expect(placed.position.distanceTo(normal.clone().negate())).toBeLessThan(1e-6)
  })

  it('counts the instances a disc holds', () => {
    expect(targetCount({ density: 100 }, 1, 1)).toBeCloseTo(Math.PI)
  })
})

describe('server objects', () => {
  beforeEach(() => {
    vi.spyOn(BaseGame, 'instance').mockReturnValue({ physicsWorld: world } as unknown as BaseGame)
    registerTerrainServerObjects()
  })

  it('builds a terrain heightfield, unless collision is off', () => {
    const heightmap = new Heightmap(3, 10)
    heightmap.heights.fill(2)
    const data = {
      id: 't',
      type: TERRAIN_TYPE,
      transform: {
        position: [0, 1, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      props: {
        size: 10,
        resolution: 3,
        heights: heightmap.encode(),
      },
    } as const
    const ctx = { scene: undefined as never, side: 'server' as const }
    const body = getSceneObject(TERRAIN_TYPE)!.server!(structuredClone(data) as never, ctx)
    expect(body).toBeInstanceOf(TerrainBody)
    expect(surfaceAt(0, 0)).toBeCloseTo(3)

    expect(getSceneObject(TERRAIN_TYPE)!.server!({
      ...structuredClone(data),
      props: { collision: false },
    } as never, ctx)).toBeUndefined()
  })

  it('builds scatter colliders at the layer', () => {
    const props = serializeScatterProps(layerWith([
      [0, 0, 0],
    ]))
    const body = getSceneObject(SCATTER_TYPE)!.server!({
      id: 's',
      type: SCATTER_TYPE,
      transform: {
        position: [4, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      props,
    }, { scene: undefined as never, side: 'server' })
    expect(body).toBeInstanceOf(ScatterBody)
    expect(surfaceAt(4, 0)).toBeCloseTo(2)
    ;(body as ScatterBody).destroy()
    expect(surfaceAt(4, 0)).toBeNull()
  })
})

describe('scatter layer', () => {
  async function layerWithRock() {
    const { BoxGeometry, Group, Mesh, MeshBasicMaterial } = await import('three')
    const { default: ScatterLayer } = await import('../../src/Scatter/ScatterLayer')
    const model = new Group()
    model.add(new Mesh(new BoxGeometry(1, 2, 1), new MeshBasicMaterial()))
    vi.mocked(Game.instance).mockReturnValue({
      scene: {
        add: vi.fn(),
        remove: vi.fn(),
      },
      resources: {
        items: {
          rock: { scene: model },
        },
        on: vi.fn(),
        off: vi.fn(),
      },
    } as any)
    const layer = new ScatterLayer({
      id: 'l',
      type: SCATTER_TYPE,
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
    })
    return layer
  }

  it('gives painted instances the brush\'s settings when the brush changes', async () => {
    const layer = await layerWithRock()
    const [entry] = parseScatterBrush({
      entries: [
        { asset: 'rock' },
      ],
    }).entries
    layer.ensureGroup(entry)
    layer.add('rock', {
      position: new Vector3(1, 0, 1),
      quaternion: new Quaternion(),
      scale: new Vector3(1, 1, 1),
    })
    layer.flush()
    const meshes = () => layer.instance.children as import('three').InstancedMesh[]
    expect(meshes()[0].castShadow).toBe(true)

    expect(layer.applyEntry({ ...entry, castShadow: false, collision: false })).toBe(true)
    expect(layer.group('rock')).toMatchObject({ castShadow: false, collision: false })
    expect(meshes()[0].castShadow).toBe(false)
    expect(layer.applyEntry({ ...entry, castShadow: false, collision: false })).toBe(false)

    // Painting with the entry applies it too
    layer.ensureGroup({ ...entry, castShadow: true })
    expect(meshes()[0].castShadow).toBe(true)
    expect(serializeScatterProps(layer.props).groups).toMatchObject([
      { castShadow: true },
    ])
  })
})
