import type { BoxGeometry, PlaneGeometry, SphereGeometry } from 'three'
import { LineSegments, Mesh, Vector3 } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Game from '../../src/Game'
import {
  BoxPrimitive,
  PlanePrimitive,
  PRIMITIVE_DEFINITIONS,
  PRIMITIVE_REGISTRY,
  resolveParams,
  SpherePrimitive,
} from '../../src/Prefab/Primitives/index'

vi.mock('../../src/Game', () => ({
  default: {
    instance: vi.fn(),
  },
}))

beforeEach(() => {
  vi.mocked(Game.instance).mockReturnValue({
    scene: {
      add: vi.fn(),
      remove: vi.fn(),
    },
  } as any)
})

describe('primitive definitions', () => {
  it('has a definition for every registered primitive', () => {
    expect(Object.keys(PRIMITIVE_REGISTRY).sort()).toEqual(Object.keys(PRIMITIVE_DEFINITIONS).sort())
  })

  it.each(Object.entries(PRIMITIVE_DEFINITIONS))('%s builds a geometry from its defaults, with defaults in range', (_name, definition) => {
    for (const param of definition.params) {
      expect(param.default).toBeGreaterThanOrEqual(param.min)
      expect(param.default).toBeLessThanOrEqual(param.max)
    }
    const geometry = definition.geometry(resolveParams(definition))
    expect(geometry.getAttribute('position').count).toBeGreaterThan(0)
  })

  it.each(Object.entries(PRIMITIVE_REGISTRY))('%s can be created and rebuilt with large params', (_name, PrimitiveClass) => {
    const primitive = new PrimitiveClass(new Vector3())
    const max = Object.fromEntries(primitive.definition.params.map(p => [
      p.key,
      Math.min(p.max, 8),
    ]))
    primitive.setParams(max)
    expect(primitive.instance.geometry.getAttribute('position').count).toBeGreaterThan(0)
    primitive.destroy()
  })
})

describe('resolveParams', () => {
  it('fills defaults, ignores unknown or invalid values and clamps', () => {
    const params = resolveParams(PRIMITIVE_DEFINITIONS.Sphere, {
      radius: -5,
      widthSegments: 12.6,
      heightSegments: 'x',
      color: '#fff',
    })
    expect(params).toEqual({
      radius: 0.01,
      widthSegments: 13,
      heightSegments: 16,
      phiLength: Math.PI * 2,
      thetaLength: Math.PI,
    })
  })
})

describe('primitive', () => {
  it('uses given params and keeps the three.js defaults otherwise', () => {
    const box = new BoxPrimitive(new Vector3(), { width: 2 })
    const geometry = box.instance.geometry as BoxGeometry
    expect(geometry.parameters).toMatchObject({ width: 2, height: 1, depth: 1 })
  })

  it('rebuilds and disposes the old geometry when a param changes', () => {
    const sphere = new SpherePrimitive(new Vector3())
    const old = sphere.instance.geometry
    const dispose = vi.spyOn(old, 'dispose')

    sphere.setParam('radius', 3)

    expect(dispose).toHaveBeenCalled()
    expect((sphere.instance.geometry as SphereGeometry).parameters.radius).toBe(3)
    expect(sphere.params.radius).toBe(3)
  })

  it('does not rebuild when nothing changes', () => {
    const sphere = new SpherePrimitive(new Vector3())
    const old = sphere.instance.geometry
    sphere.setParams({ radius: 1, unknown: 4 })
    expect(sphere.instance.geometry).toBe(old)
  })

  it('keeps a plane lying flat after it is resized', () => {
    const plane = new PlanePrimitive(new Vector3(), { width: 4, height: 2 })
    plane.setParam('width', 6)

    const geometry = plane.instance.geometry as PlaneGeometry
    geometry.computeBoundingBox()
    expect(geometry.boundingBox!.max.y).toBeCloseTo(0)
    expect(geometry.boundingBox!.max.x).toBeCloseTo(3)
    expect(geometry.boundingBox!.max.z).toBeCloseTo(1)
    expect(plane.width).toBe(6)
    expect(plane.height).toBe(2)
  })

  it('draws edge and wireframe primitives as lines', () => {
    expect(new PRIMITIVE_REGISTRY.Edges(new Vector3()).instance).toBeInstanceOf(LineSegments)
    expect(new PRIMITIVE_REGISTRY.Box(new Vector3()).instance).toBeInstanceOf(Mesh)
  })
})

describe('pivot', () => {
  function bounds(primitive: InstanceType<typeof SpherePrimitive>) {
    primitive.instance.geometry.computeBoundingBox()
    return primitive.instance.geometry.boundingBox!
  }

  it('centers by default', () => {
    const sphere = new SpherePrimitive(new Vector3())
    expect(sphere.pivot).toBe('center')
    expect(bounds(sphere).min.y).toBeCloseTo(-1)
  })

  it.each(Object.entries(PRIMITIVE_REGISTRY))('%s rests on y = 0 with a base pivot', (_name, PrimitiveClass) => {
    const primitive = new PrimitiveClass(new Vector3(), undefined, { pivot: 'base' })
    expect(bounds(primitive).min.y).toBeCloseTo(0)
  })

  it('keeps the base on the ground when made taller', () => {
    const box = new BoxPrimitive(new Vector3(), undefined, { pivot: 'base' })
    box.setParam('height', 4)
    expect(bounds(box).min.y).toBeCloseTo(0)
    expect(bounds(box).max.y).toBeCloseTo(4)
  })

  it('switches between pivots', () => {
    const box = new BoxPrimitive(new Vector3())
    box.setPivot('base')
    expect(bounds(box).min.y).toBeCloseTo(0)
    box.setPivot('center')
    expect(bounds(box).min.y).toBeCloseTo(-0.5)
  })
})
