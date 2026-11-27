import type { Texture } from 'three'
import type { MeshStandardNodeMaterial } from 'three/webgpu'
import type { GraphValue, PinType } from '../types'
import {
  abs,
  cameraPosition,
  clamp,
  cos,
  cross,
  distance,
  dot,
  float,
  floor,
  fract,
  length,
  max,
  min,
  mix,
  normalize,
  normalWorld,
  positionLocal,
  positionWorld,
  pow,
  sin,
  smoothstep,
  sqrt,
  step,
  texture,
  time,
  uv,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'
import { perlinNoise3D, valueNoise2D } from '../../Shaders/Nodes/noise'
import { componentCount } from '../NodeRegistry'

/** A TSL node. Untyped: the graph decides what flows where */
export type TslNode = any

export interface TslNodeContext {
  /** The node's settings and unconnected input values */
  values: Record<string, GraphValue>
  /** The inputs that have an edge */
  connected: Set<string>
  /** What type each input got: from its edge, or its value */
  types: Record<string, PinType>
  /** The uniform behind one of the graph's parameters */
  parameter(name: string): TslNode | undefined
  /** A texture from the game's resources, by name */
  texture(name: string): Texture | undefined
  material: MeshStandardNodeMaterial
}

/** Builds a node's outputs, as TSL nodes, from its inputs as TSL nodes */
export type TslImplementation = (inputs: Record<string, TslNode>, context: TslNodeContext) => Record<string, TslNode>

const implementations = new Map<string, TslImplementation>()

/** The TSL side of a node type (see `registerNode()`), for material graphs */
export function registerTslNode(type: string, implementation: TslImplementation): void {
  implementations.set(type, implementation)
}

export function getTslNode(type: string): TslImplementation | undefined {
  return implementations.get(type)
}

/** A value written in the graph, as a TSL constant of `type` */
export function tslConstant(value: GraphValue | undefined, type: PinType): TslNode {
  const v = Array.isArray(value)
    ? value
    : [
        typeof value === 'number'
          ? value
          : Number(value ?? 0),
      ]
  const at = (i: number) => v[i] ?? v[0] ?? 0
  switch (type) {
    case 'vec2':
      return vec2(at(0), at(1))
    case 'vec3':
    case 'color':
      return vec3(at(0), at(1), at(2))
    case 'vec4':
      return vec4(at(0), at(1), at(2), at(3))
    default:
      return float(at(0))
  }
}

/** `node` as `type`: a float spreads over a vector, a wider vector is cut down to its first components */
export function tslConvert(node: TslNode, type: PinType): TslNode {
  switch (type) {
    case 'float':
    case 'int':
      return float(node)
    case 'vec2':
      return vec2(node)
    case 'vec3':
    case 'color':
      return vec3(node)
    case 'vec4':
      return vec4(node)
    default:
      return node
  }
}

function unary(fn: (x: TslNode) => TslNode): TslImplementation {
  return ({ x }) => ({
    result: fn(x),
  })
}
function binary(fn: (a: TslNode, b: TslNode) => TslNode): TslImplementation {
  return ({ a, b }) => ({
    result: fn(a, b),
  })
}

const BUILTIN: Record<string, TslImplementation> = {
  'input.float': (_, { values }) => ({
    value: tslConstant(values.value ?? 0, 'float'),
  }),
  'input.vec2': (_, { values }) => ({
    value: tslConstant(values.value ?? 0, 'vec2'),
  }),
  'input.vec3': (_, { values }) => ({
    value: tslConstant(values.value ?? 0, 'vec3'),
  }),
  'input.vec4': (_, { values }) => ({
    value: tslConstant(values.value ?? 0, 'vec4'),
  }),
  'input.color': (_, { values }) => ({
    value: tslConstant(values.value ?? 1, 'color'),
  }),
  'input.parameter': (_, { values, parameter }) => ({ value: parameter(String(values.name ?? '')) ?? float(0) }),
  'input.time': () => ({ seconds: time }),

  'surface.uv': () => ({
    value: uv(),
  }),
  'surface.positionWorld': () => ({ value: positionWorld }),
  'surface.positionLocal': () => ({ value: positionLocal }),
  'surface.normalWorld': () => ({ value: normalWorld }),
  'surface.viewDirection': () => ({
    value: normalize(cameraPosition.sub(positionWorld)),
  }),

  'math.add': binary((a, b) => a.add(b)),
  'math.subtract': binary((a, b) => a.sub(b)),
  'math.multiply': binary((a, b) => a.mul(b)),
  'math.divide': binary((a, b) => a.div(b)),
  'math.min': binary(min),
  'math.max': binary(max),
  'math.pow': binary(pow),
  'math.step': binary(step),
  'math.sin': unary(sin),
  'math.cos': unary(cos),
  'math.abs': unary(abs),
  'math.floor': unary(floor),
  'math.fract': unary(fract),
  'math.sqrt': unary(sqrt),
  'math.negate': unary(x => x.negate()),
  'math.oneMinus': unary(x => x.oneMinus()),
  'math.mix': ({ a, b, t }) => ({
    result: mix(a, b, t),
  }),
  'math.clamp': ({ x, min: lo, max: hi }) => ({
    result: clamp(x, lo, hi),
  }),
  'math.smoothstep': ({ edge0, edge1, x }) => ({
    result: smoothstep(edge0, edge1, x),
  }),
  'math.remap': ({ x, inMin, inMax, outMin, outMax }) => ({
    result: x.sub(inMin).div(inMax.sub(inMin)).mul(outMax.sub(outMin)).add(outMin),
  }),

  'vector.length': ({ vector }) => ({
    length: length(vector),
  }),
  'vector.distance': ({ a, b }) => ({
    distance: distance(a, b),
  }),
  'vector.dot': ({ a, b }) => ({
    result: dot(a, b),
  }),
  'vector.normalize': ({ vector }) => ({
    result: normalize(vector),
  }),
  'vector.cross': ({ a, b }) => ({
    result: cross(a, b),
  }),
  // The components the vector has, 0 for the rest
  'vector.split': ({ vector }, { types }) => {
    const count = componentCount(types.vector ?? 'float') ?? 1
    if (count === 1) {
      return {
        x: vector,
        y: float(0),
        z: float(0),
        w: float(0),
      }
    }
    return {
      x: vector.x,
      y: vector.y,
      z: count > 2
        ? vector.z
        : float(0),
      w: count > 3
        ? vector.w
        : float(0),
    }
  },
  'vector.combine2': ({ x, y }) => ({
    vector: vec2(x, y),
  }),
  'vector.combine3': ({ x, y, z }) => ({
    vector: vec3(x, y, z),
  }),
  'vector.combine4': ({ x, y, z, w }) => ({
    vector: vec4(x, y, z, w),
  }),

  'texture.sample': (inputs, context) => {
    const map = context.texture(String(context.values.texture ?? ''))
    if (!map) {
      // Magenta, so a missing texture stands out
      const missing = vec4(1, 0, 1, 1)
      return {
        color: missing,
        rgb: missing.xyz,
        alpha: float(1),
      }
    }
    const sample = context.connected.has('uv')
      ? texture(map, inputs.uv)
      : texture(map)
    return { color: sample, rgb: sample.xyz, alpha: sample.w }
  },
  'noise.perlin3d': ({ position }) => ({
    value: perlinNoise3D(position),
  }),
  'noise.value2d': ({ position }) => ({
    value: valueNoise2D(position),
  }),

  // Inside a subgraph its node hands in the inputs (see registerMaterialSubgraph); on its own, the default
  'graph.input': (_, { values }) => ({
    value: tslConstant(values.default ?? 0, 'float'),
  }),
  'graph.output': () => ({}),
  // A note: nothing to build
  'graph.comment': () => ({}),
  'material.output': (inputs, { connected, material }) => {
    if (connected.has('color'))
      material.colorNode = inputs.color
    if (connected.has('opacity')) {
      material.opacityNode = inputs.opacity
      material.transparent = true
    }
    if (connected.has('roughness'))
      material.roughnessNode = inputs.roughness
    if (connected.has('metalness'))
      material.metalnessNode = inputs.metalness
    if (connected.has('emissive'))
      material.emissiveNode = inputs.emissive
    if (connected.has('normal'))
      material.normalNode = inputs.normal
    if (connected.has('positionOffset'))
      material.positionNode = positionLocal.add(inputs.positionOffset)
    return {}
  },
}

for (const [type, implementation] of Object.entries(BUILTIN))
  registerTslNode(type, implementation)
