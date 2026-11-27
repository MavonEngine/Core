import type { BufferGeometry } from 'three'
import {
  BoxGeometry,
  CapsuleGeometry,
  CatmullRomCurve3,
  CircleGeometry,
  ConeGeometry,
  CylinderGeometry,
  DodecahedronGeometry,
  EdgesGeometry,
  ExtrudeGeometry,
  IcosahedronGeometry,
  LatheGeometry,
  OctahedronGeometry,
  PlaneGeometry,
  PolyhedronGeometry,
  RingGeometry,
  Shape,
  ShapeGeometry,
  SphereGeometry,
  TetrahedronGeometry,
  TorusGeometry,
  TorusKnotGeometry,
  TubeGeometry,
  Vector2,
  Vector3,
  WireframeGeometry,
} from 'three'
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js'

/*
 * The shapes of the built-in primitives, without anything that renders them.
 * Safe to import on the server, which builds their colliders from these.
 */

/** One number that shapes a primitive's geometry, shown as a slider in the editor */
export interface GeometryParam {
  key: string
  default: number
  min: number
  max: number
  step: number
}

export type GeometryParams = Record<string, number>

export interface PrimitiveDefinition {
  label: string
  params: GeometryParam[]
  /** Builds the geometry from a full set of params */
  geometry(p: GeometryParams): BufferGeometry
  /** Drawn as lines instead of a lit mesh */
  lines?: boolean
}

const TAU = Math.PI * 2

/** Helpers to keep the definitions short */
function size(key: string, value = 1, max = 100): GeometryParam {
  return {
    key,
    default: value,
    min: 0.01,
    max,
    step: 0.01,
  }
}
function segments(key: string, value: number, min = 1, max = 128): GeometryParam {
  return {
    key,
    default: value,
    min,
    max,
    step: 1,
  }
}
function angle(key: string, value = TAU): GeometryParam {
  return {
    key,
    default: value,
    min: 0.01,
    max: TAU,
    step: 0.01,
  }
}
function detail(value = 0): GeometryParam {
  return {
    key: 'detail',
    default: value,
    min: 0,
    max: 5,
    step: 1,
  }
}

function rectangle(width: number, height: number): Shape {
  const shape = new Shape()
  shape.moveTo(0, 0)
  shape.lineTo(0, height)
  shape.lineTo(width, height)
  shape.lineTo(width, 0)
  shape.closePath()
  return shape
}

/** Builds a derived geometry from a box of the given size, then frees the box */
function fromBox<T extends BufferGeometry>(p: GeometryParams, derive: (box: BoxGeometry) => T): T {
  const box = new BoxGeometry(p.width, p.height, p.depth)
  const derived = derive(box)
  box.dispose()
  return derived
}

const boxSize = [
  size('width'),
  size('height'),
  size('depth'),
]

/**
 * Defaults match what each primitive looked like before it had params, so scenes saved
 * without them load unchanged.
 */
export const PRIMITIVE_DEFINITIONS = {
  Box: {
    label: 'Box',
    params: [
      ...boxSize,
      segments('widthSegments', 1),
      segments('heightSegments', 1),
      segments('depthSegments', 1),
    ],
    geometry: p => new BoxGeometry(p.width, p.height, p.depth, p.widthSegments, p.heightSegments, p.depthSegments),
  },
  Capsule: {
    label: 'Capsule',
    params: [
      size('radius'),
      size('height'),
      segments('capSegments', 4),
      segments('radialSegments', 8, 3),
      segments('heightSegments', 1),
    ],
    geometry: p => new CapsuleGeometry(p.radius, p.height, p.capSegments, p.radialSegments, p.heightSegments),
  },
  Circle: {
    label: 'Circle',
    params: [
      size('radius'),
      segments('segments', 32, 3),
      angle('thetaLength'),
    ],
    geometry: p => new CircleGeometry(p.radius, p.segments, 0, p.thetaLength),
  },
  Cone: {
    label: 'Cone',
    params: [
      size('radius'),
      size('height'),
      segments('radialSegments', 32, 3),
      segments('heightSegments', 1),
      angle('thetaLength'),
    ],
    geometry: p => new ConeGeometry(p.radius, p.height, p.radialSegments, p.heightSegments, false, 0, p.thetaLength),
  },
  Cylinder: {
    label: 'Cylinder',
    params: [
      {
        ...size('radiusTop'),
        min: 0,
      },
      {
        ...size('radiusBottom'),
        min: 0,
      },
      size('height'),
      segments('radialSegments', 32, 3),
      segments('heightSegments', 1),
      angle('thetaLength'),
    ],
    geometry: p => new CylinderGeometry(p.radiusTop, p.radiusBottom, p.height, p.radialSegments, p.heightSegments, false, 0, p.thetaLength),
  },
  Dodecahedron: {
    label: 'Dodecahedron',
    params: [
      size('radius'),
      detail(),
    ],
    geometry: p => new DodecahedronGeometry(p.radius, p.detail),
  },
  Edges: {
    label: 'Edges',
    params: [
      ...boxSize,
      {
        key: 'thresholdAngle',
        default: 1,
        min: 0,
        max: 180,
        step: 1,
      },
    ],
    geometry: p => fromBox(p, box => new EdgesGeometry(box, p.thresholdAngle)),
    lines: true,
  },
  Extrude: {
    label: 'Extrude',
    params: [
      size('width'),
      size('height'),
      size('depth', 0.5),
    ],
    geometry: p => new ExtrudeGeometry(rectangle(p.width, p.height), { depth: p.depth, bevelEnabled: false }),
  },
  Icosahedron: {
    label: 'Icosahedron',
    params: [
      size('radius'),
      detail(),
    ],
    geometry: p => new IcosahedronGeometry(p.radius, p.detail),
  },
  Lathe: {
    label: 'Lathe',
    params: [
      size('radius'),
      size('height'),
      segments('segments', 12, 3),
      angle('phiLength'),
    ],
    geometry: (p) => {
      // A vase-like profile, scaled to the requested size
      const points: Vector2[] = []
      for (let i = 0; i <= 10; i++) {
        points.push(new Vector2((Math.sin(i * 0.2) * 0.5 + 0.3) * p.radius, i * 0.1 * p.height))
      }
      return new LatheGeometry(points, p.segments, 0, p.phiLength)
    },
  },
  Octahedron: {
    label: 'Octahedron',
    params: [
      size('radius'),
      detail(),
    ],
    geometry: p => new OctahedronGeometry(p.radius, p.detail),
  },
  Plane: {
    label: 'Plane',
    params: [
      size('width', 1, 1000),
      size('height', 1, 1000),
      segments('widthSegments', 1),
      segments('heightSegments', 1),
    ],
    geometry: (p) => {
      const geometry = new PlaneGeometry(p.width, p.height, p.widthSegments, p.heightSegments)
      // Lie flat on the ground
      geometry.rotateX(-Math.PI / 2)
      return geometry
    },
  },
  Polyhedron: {
    label: 'Polyhedron',
    params: [
      size('radius', 0.8),
      detail(2),
    ],
    geometry: (p) => {
      const vertices = [
        1,
        1,
        1,
        -1,
        -1,
        1,
        -1,
        1,
        -1,
        1,
        -1,
        -1,
      ]
      const indices = [2, 1, 0, 0, 3, 2, 1, 3, 0, 2, 3, 1]
      return new PolyhedronGeometry(vertices, indices, p.radius, p.detail)
    },
  },
  Ring: {
    label: 'Ring',
    params: [
      {
        ...size('innerRadius', 0.5),
        min: 0,
      },
      size('outerRadius'),
      segments('thetaSegments', 32, 3),
      segments('phiSegments', 1),
      angle('thetaLength'),
    ],
    geometry: p => new RingGeometry(p.innerRadius, p.outerRadius, p.thetaSegments, p.phiSegments, 0, p.thetaLength),
  },
  Shape: {
    label: 'Shape',
    params: [
      size('width'),
      size('height'),
    ],
    geometry: p => new ShapeGeometry(rectangle(p.width, p.height)),
  },
  Sphere: {
    label: 'Sphere',
    params: [
      size('radius'),
      segments('widthSegments', 32, 3),
      segments('heightSegments', 16, 2),
      angle('phiLength'),
      angle('thetaLength', Math.PI),
    ],
    geometry: p => new SphereGeometry(p.radius, p.widthSegments, p.heightSegments, 0, p.phiLength, 0, p.thetaLength),
  },
  Stairs: {
    label: 'Stairs',
    params: [
      segments('steps', 8, 1, 64),
      size('width'),
      size('height', 2),
      size('depth', 3),
    ],
    geometry: (p) => {
      // Solid steps from the ground up, climbing towards -Z
      const rise = p.height / p.steps
      const run = p.depth / p.steps
      const steps: BufferGeometry[] = []
      for (let i = 0; i < p.steps; i++) {
        const stepHeight = rise * (i + 1)
        const step = new BoxGeometry(p.width, stepHeight, run)
        step.translate(0, stepHeight / 2, -run * (i + 0.5))
        steps.push(step)
      }
      const geometry = mergeGeometries(steps)
      steps.forEach(step => step.dispose())
      return geometry.center()
    },
  },
  Tetrahedron: {
    label: 'Tetrahedron',
    params: [
      size('radius'),
      detail(),
    ],
    geometry: p => new TetrahedronGeometry(p.radius, p.detail),
  },
  Torus: {
    label: 'Torus',
    params: [
      size('radius'),
      size('tube', 0.4),
      segments('radialSegments', 12, 2),
      segments('tubularSegments', 48, 3, 256),
      angle('arc'),
    ],
    geometry: p => new TorusGeometry(p.radius, p.tube, p.radialSegments, p.tubularSegments, p.arc),
  },
  TorusKnot: {
    label: 'TorusKnot',
    params: [
      size('radius'),
      size('tube', 0.4),
      segments('tubularSegments', 64, 3, 512),
      segments('radialSegments', 8, 3),
      segments('p', 2, 1, 20),
      segments('q', 3, 1, 20),
    ],
    geometry: p => new TorusKnotGeometry(p.radius, p.tube, p.tubularSegments, p.radialSegments, p.p, p.q),
  },
  Tube: {
    label: 'Tube',
    params: [
      size('length', 2),
      size('radius', 0.2),
      segments('tubularSegments', 20, 2, 256),
      segments('radialSegments', 8, 3),
    ],
    geometry: (p) => {
      const half = p.length / 2
      const path = new CatmullRomCurve3([
        new Vector3(-half, 0, 0),
        new Vector3(-half / 2, half / 2, 0),
        new Vector3(half / 2, -half / 2, 0),
        new Vector3(half, 0, 0),
      ])
      return new TubeGeometry(path, p.tubularSegments, p.radius, p.radialSegments, false)
    },
  },
  Wireframe: {
    label: 'Wireframe',
    params: boxSize,
    geometry: p => fromBox(p, box => new WireframeGeometry(box)),
    lines: true,
  },
} satisfies Record<string, PrimitiveDefinition>

export type PrimitiveName = keyof typeof PRIMITIVE_DEFINITIONS

/** Clamps a value into a param's range and onto its step */
function clampParam(param: GeometryParam, value: number): number {
  const clamped = Math.min(param.max, Math.max(param.min, value))
  return param.step >= 1
    ? Math.round(clamped)
    : clamped
}

/** The full set of params for a definition: defaults, overridden by any valid values given */
export function resolveParams(definition: PrimitiveDefinition, given: Partial<Record<string, unknown>> = {}): GeometryParams {
  const params: GeometryParams = {}
  for (const param of definition.params) {
    const value = given[param.key]
    params[param.key] = typeof value === 'number' && Number.isFinite(value)
      ? clampParam(param, value)
      : param.default
  }
  return params
}

/**
 * Where the primitive's origin sits: `center` of its geometry (three.js default) or the `base`,
 * so it stands on whatever it is placed on and grows upwards when made taller.
 */
export type PrimitivePivot = 'center' | 'base'

export interface PrimitiveOptions {
  pivot?: PrimitivePivot
  /** Adds a fixed collider shaped like the geometry when there is a physics world. On by default, never for line primitives */
  collision?: boolean
}

/** Whether a primitive gets a collider. Lines have no surface to collide with */
export function primitiveCollides(definition: PrimitiveDefinition, collision?: boolean): boolean {
  return !definition.lines && collision !== false
}

/** Moves a geometry up so its lowest point is at y = 0 */
export function moveToBase(geometry: BufferGeometry): BufferGeometry {
  geometry.computeBoundingBox()
  const bottom = geometry.boundingBox?.min.y ?? 0
  if (bottom !== 0)
    geometry.translate(0, -bottom, 0)
  return geometry
}

/** Builds a primitive's geometry from its params, moved for its pivot */
export function buildPrimitiveGeometry(definition: PrimitiveDefinition, params: GeometryParams, pivot: PrimitivePivot = 'center'): BufferGeometry {
  const geometry = definition.geometry(params)
  return pivot === 'base'
    ? moveToBase(geometry)
    : geometry
}
