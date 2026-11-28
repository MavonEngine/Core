import type { BrushContext } from '../../src/Brushes/BrushRegistry'
import type Terrain from '../../src/Terrain/Terrain'
import { Vector3 } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { brushKey, brushOptionDefaults, getBrush, getBrushes, registerBrush, unregisterBrush } from '../../src/Brushes/BrushRegistry'
import { registerBuiltinBrushes } from '../../src/Brushes/builtinBrushes'
import { Heightmap } from '../../src/Terrain/terrainData'

vi.mock('../../src/Game', () => ({
  default: {
    instance: vi.fn(),
  },
}))

function context(changes: Partial<BrushContext> = {}): BrushContext {
  return {
    scene: undefined as never,
    settings: { radius: 3, strength: 1, falloff: 0.5 },
    options: {},
    invert: false,
    paintLayer: 0,
    scatterLayer: () => undefined,
    surfaceBelow: () => undefined,
    random: Math.random,
    ...changes,
  }
}

/** Enough of a terrain for the sculpt brushes: local space is world space */
function fakeTerrain(): Terrain {
  const terrain = {
    heightmap: new Heightmap(33, 32),
    worldScale: 1,
    toLocal: (p: Vector3) => p.clone(),
    heightsChanged: vi.fn(),
    commit: vi.fn(),
  }
  return terrain as unknown as Terrain
}

describe('brush registry', () => {
  it('keys plugins\' brushes by package and lists the built-in ones first', () => {
    registerBuiltinBrushes()
    const key = registerBrush({
      name: 'road',
      plugin: '@acme/roads',
      group: 'Roads',
      target: 'surface',
      begin: () => undefined,
    })
    expect(key).toBe('@acme/roads:road')
    expect(brushKey({ name: 'x' })).toBe('x')

    const all = getBrushes()
    expect(all[0].plugin).toBeUndefined()
    expect(all.at(-1)!.key).toBe(key)
    expect(all.map(b => b.group)).toEqual(expect.arrayContaining(['Sculpt', 'Paint', 'Scatter', 'Roads']))

    unregisterBrush(key)
    expect(getBrush(key)).toBeUndefined()
  })

  it('gives option defaults', () => {
    expect(brushOptionDefaults(getBrush('sculpt.noise')!)).toEqual({ noiseScale: 0.15 })
  })
})

describe('built-in brushes', () => {
  it('only start a sculpt stroke on a terrain', () => {
    registerBuiltinBrushes()
    expect(getBrush('sculpt.raise')!.begin({
      point: new Vector3(),
      normal: new Vector3(0, 1, 0),
    }, context())).toBeUndefined()
  })

  it('sculpt, then undo and redo the stroke', () => {
    registerBuiltinBrushes()
    const terrain = fakeTerrain()
    const hit = {
      point: new Vector3(),
      normal: new Vector3(0, 1, 0),
      terrain,
    }
    const stroke = getBrush('sculpt.raise')!.begin(hit, context())!
    stroke.stamp(hit, context())
    stroke.stamp(hit, context())
    const raised = terrain.heightmap.sample(0, 0)
    expect(raised).toBeGreaterThan(0)

    const undo = stroke.end(context())!
    expect(terrain.commit).toHaveBeenCalled()
    undo.undo()
    expect(terrain.heightmap.sample(0, 0)).toBe(0)
    undo.redo()
    expect(terrain.heightmap.sample(0, 0)).toBeCloseTo(raised)
  })

  it('lowers with Shift held', () => {
    registerBuiltinBrushes()
    const terrain = fakeTerrain()
    const hit = {
      point: new Vector3(),
      normal: new Vector3(0, 1, 0),
      terrain,
    }
    const stroke = getBrush('sculpt.raise')!.begin(hit, context({ invert: true }))!
    stroke.stamp(hit, context({ invert: true }))
    expect(terrain.heightmap.sample(0, 0)).toBeLessThan(0)
  })

  it('won\'t paint assets without a scatter brush', () => {
    registerBuiltinBrushes()
    const warn = vi.fn()
    expect(getBrush('scatter.paint')!.begin({
      point: new Vector3(),
      normal: new Vector3(0, 1, 0),
    }, context({
      logger: { warn },
    }))).toBeUndefined()
    expect(warn).toHaveBeenCalled()
  })
})
