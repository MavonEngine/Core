import type { World } from '@dimforge/rapier3d-compat'
import RAPIER from '@dimforge/rapier3d-compat'
import { Quaternion, Vector3 } from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import { decodeBytes, decodeFloat32, encodeBytes, encodeFloat32 } from '../../src/Terrain/codec'
import { restoreHeights, sculpt, snapshotHeights } from '../../src/Terrain/sculpt'
import { brushFalloff, SplatMap } from '../../src/Terrain/splatMap'
import { TerrainCollider } from '../../src/Terrain/TerrainCollider'
import { buildTerrainGeometry, Heightmap, splatResolutionFor, terrainPropsFrom } from '../../src/Terrain/terrainData'

beforeAll(async () => {
  await RAPIER.init()
})

describe('codec', () => {
  it('round trips bytes and floats', () => {
    const bytes = Uint8Array.from({ length: 100_000 }, (_, i) => i % 7)
    expect(decodeBytes(encodeBytes(bytes))).toEqual(bytes)
    const floats = Float32Array.from({ length: 1000 }, (_, i) => Math.sin(i) * 10)
    expect(decodeFloat32(encodeFloat32(floats))).toEqual(floats)
  })

  it('throws on what it did not write', () => {
    expect(() => decodeBytes('bm90IHpsaWI=')).toThrow()
  })
})

describe('splatResolutionFor', () => {
  it('rounds texels per meter up to a power of two within 256 – 4096', () => {
    expect(splatResolutionFor(200)).toBe(1024)
    expect(splatResolutionFor(10)).toBe(256)
    expect(splatResolutionFor(2000)).toBe(4096)
    expect(splatResolutionFor(4, 64)).toBe(256)
  })
})

describe('terrainPropsFrom', () => {
  it('fills in defaults and drops broken layers', () => {
    const props = terrainPropsFrom({
      size: 100,
      layers: [
        { graph: 'grass' },
        { nope: 1 },
        null,
      ],
      collision: false,
    })
    expect(props.size).toBe(100)
    expect(props.splatResolution).toBe(512)
    expect(props.layers).toEqual([
      { graph: 'grass', tiling: 20 },
    ])
    expect(props.collision).toBe(false)
    expect(props.receiveShadow).toBe(true)
  })
})

describe('heightmap', () => {
  it('samples between grid points and round trips through the props', () => {
    const map = new Heightmap(3, 10)
    map.set(1, 1, 4)
    expect(map.sample(0, 0)).toBeCloseTo(4)
    expect(map.sample(2.5, 0)).toBeCloseTo(2)
    expect(map.sample(-100, -100)).toBe(0)

    const copy = Heightmap.fromProps({
      resolution: 3,
      size: 10,
      heights: map.encode(),
    })
    expect(copy.heights).toEqual(map.heights)
    expect(new Heightmap(3, 10).encode()).toBeUndefined()
  })

  it('falls back to flat when the heights do not fit', () => {
    const map = new Heightmap(3, 10)
    map.set(0, 0, 1)
    expect(Heightmap.fromProps({
      resolution: 5,
      size: 10,
      heights: map.encode(),
    }).heights.every(h => h === 0)).toBe(true)
  })

  it('builds a grid facing up, with the heights in it', () => {
    const map = new Heightmap(5, 8)
    map.set(4, 0, 2)
    const geometry = buildTerrainGeometry(map)
    const position = geometry.getAttribute('position')
    // Column 4 of row 0 is at x = 4, z = -4
    expect([
      position.getX(4),
      position.getY(4),
      position.getZ(4),
    ]).toEqual([4, 2, -4])
    expect(geometry.getAttribute('normal').getY(12)).toBeCloseTo(1)

    const index = geometry.getIndex()!
    const a = new Vector3().fromBufferAttribute(position, index.getX(0))
    const b = new Vector3().fromBufferAttribute(position, index.getX(1))
    const c = new Vector3().fromBufferAttribute(position, index.getX(2))
    expect(b.sub(a).cross(c.sub(a)).y).toBeGreaterThan(0)
  })

  it('resamples to another resolution', () => {
    const map = new Heightmap(3, 10)
    map.set(2, 2, 6)
    const finer = map.resample(5)
    expect(finer.get(4, 4)).toBeCloseTo(6)
    expect(finer.get(3, 3)).toBeCloseTo(1.5)
  })
})

describe('terrain collider', () => {
  function surfaceAt(world: World, x: number, z: number): number | null {
    world.step()
    const hit = world.castRay(new RAPIER.Ray({ x, y: 50, z }, { x: 0, y: -1, z: 0 }), 100, true)
    return hit
      ? 50 - hit.timeOfImpact
      : null
  }

  it('matches the heights where the mesh has them', () => {
    const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 })
    const map = new Heightmap(5, 8)
    // A hill in one corner only: row 0 (z = -4), column 4 (x = 4)
    map.set(4, 0, 3)
    map.set(1, 3, 1)
    const collider = new TerrainCollider(world, map, {
      position: new Vector3(10, 1, 0),
      quaternion: new Quaternion(),
      scale: new Vector3(1, 1, 1),
    })

    expect(surfaceAt(world, 14 - 0.01, -4 + 0.01)).toBeCloseTo(4, 1)
    expect(surfaceAt(world, 6 + 0.01, 4 - 0.01)).toBeCloseTo(1, 1)
    // Column 1 (x = -2), row 3 (z = 2)
    expect(surfaceAt(world, 8, 2)).toBeCloseTo(2, 1)
    expect(surfaceAt(world, 0, 0)).toBeNull()

    collider.destroy()
    expect(surfaceAt(world, 8, 2)).toBeNull()
  })
})

describe('sculpt', () => {
  it('raises, lowers, flattens and smooths around the brush', () => {
    const map = new Heightmap(33, 32)
    const raised = sculpt(map, {
      mode: 'raise',
      x: 0,
      z: 0,
      radius: 4,
      falloff: 1,
      strength: 1,
    })!
    expect(map.sample(0, 0)).toBeGreaterThan(0)
    expect(map.sample(10, 10)).toBe(0)
    expect(raised.col0).toBeGreaterThan(0)

    const peak = map.sample(0, 0)
    sculpt(map, {
      mode: 'smooth',
      x: 0,
      z: 0,
      radius: 4,
      falloff: 0,
      strength: 1,
    })
    expect(map.sample(0, 0)).toBeLessThan(peak)

    sculpt(map, {
      mode: 'flatten',
      x: 0,
      z: 0,
      radius: 6,
      falloff: 0,
      strength: 1,
      target: 0,
    })
    expect(map.sample(0, 0)).toBeCloseTo(0)

    sculpt(map, {
      mode: 'lower',
      x: 0,
      z: 0,
      radius: 4,
      falloff: 0,
      strength: 1,
    })
    expect(map.sample(0, 0)).toBeLessThan(0)
  })

  it('puts a region back from a snapshot', () => {
    const map = new Heightmap(9, 8)
    const region = { col0: 2, row0: 2, col1: 6, row1: 6 }
    const before = snapshotHeights(map, region)
    sculpt(map, {
      mode: 'raise',
      x: 0,
      z: 0,
      radius: 2,
      falloff: 0,
      strength: 1,
    })
    restoreHeights(map, region, before)
    expect(map.heights.every(h => h === 0)).toBe(true)
  })
})

describe('splat map', () => {
  it('starts covered by the first layer', () => {
    const splat = new SplatMap(16, 3)
    expect(splat.weight(0, 3, 3)).toBe(1)
    expect(splat.weight(1, 3, 3)).toBe(0)
    expect(splat.maps).toHaveLength(1)
    expect(new SplatMap(16, 5).maps).toHaveLength(2)
  })

  it('paints a layer, keeping the weights adding up to one', () => {
    const splat = new SplatMap(32, 4)
    splat.paint({
      layer: 2,
      x: 16,
      y: 16,
      radius: 4,
      falloff: 0,
      strength: 1,
      mode: 'paint',
    })
    expect(splat.weight(2, 16, 16)).toBe(1)
    expect(splat.weight(0, 16, 16)).toBe(0)
    expect(splat.weight(0, 2, 2)).toBe(1)

    splat.paint({
      layer: 1,
      x: 16,
      y: 16,
      radius: 4,
      falloff: 0,
      strength: 0.5,
      mode: 'paint',
    })
    const sum = [0, 1, 2, 3].reduce((s, l) => s + splat.weight(l, 16, 16), 0)
    expect(sum).toBeCloseTo(1, 5)
    expect(splat.weight(1, 16, 16)).toBeCloseTo(0.5, 1)
    expect(splat.weight(2, 16, 16)).toBeCloseTo(0.5, 1)
  })

  it('erases a layer back to the others, or to the first one', () => {
    const splat = new SplatMap(32, 4)
    splat.paint({
      layer: 3,
      x: 16,
      y: 16,
      radius: 4,
      falloff: 0,
      strength: 1,
      mode: 'paint',
    })
    splat.paint({
      layer: 3,
      x: 16,
      y: 16,
      radius: 4,
      falloff: 0,
      strength: 1,
      mode: 'erase',
    })
    expect(splat.weight(3, 16, 16)).toBe(0)
    expect(splat.weight(0, 16, 16)).toBe(1)
  })

  it('removes a layer, moving the later ones down', () => {
    const splat = new SplatMap(8, 3)
    splat.paint({
      layer: 2,
      x: 4,
      y: 4,
      radius: 8,
      falloff: 0,
      strength: 1,
      mode: 'paint',
    })
    splat.removeLayer(1, 3)
    expect(splat.weight(1, 4, 4)).toBe(1)
    expect(splat.weight(2, 4, 4)).toBe(0)
  })

  it('round trips, snapshots and resamples', () => {
    const splat = new SplatMap(16, 2)
    splat.paint({
      layer: 1,
      x: 8,
      y: 8,
      radius: 3,
      falloff: 0.5,
      strength: 1,
      mode: 'paint',
    })
    const copy = SplatMap.fromProps(16, 2, splat.encode())
    expect(copy.maps[0]).toEqual(splat.maps[0])

    const region = { col0: 0, row0: 0, col1: 15, row1: 15 }
    const before = splat.snapshot(region)
    splat.fill(1)
    expect(splat.weight(1, 0, 0)).toBe(1)
    splat.restore(region, before)
    expect(splat.maps[0]).toEqual(copy.maps[0])

    expect(splat.resample(32).weight(1, 16, 16)).toBe(1)
  })

  it('falls back to the first layer with broken data', () => {
    expect(SplatMap.fromProps(8, 2, ['broken']).weight(0, 1, 1)).toBe(1)
  })
})

describe('brushFalloff', () => {
  it('is 1 in the core and eases to 0 at the radius', () => {
    expect(brushFalloff(0, 4, 0.5)).toBe(1)
    expect(brushFalloff(2, 4, 0.5)).toBe(1)
    expect(brushFalloff(3, 4, 0.5)).toBeCloseTo(0.5)
    expect(brushFalloff(4, 4, 0.5)).toBe(0)
    expect(brushFalloff(3.9, 4, 0)).toBe(1)
  })
})
