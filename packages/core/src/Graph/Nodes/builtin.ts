import type { NodeDefinition, PortSpec } from '../NodeRegistry'
import type { GraphKind, GraphValue, PinType } from '../types'
import { registerNode } from '../NodeRegistry'
import { GRAPH_COMMENT, GRAPH_GROUP } from '../types'
import { LOGIC_NODES } from './logic'
import { SUBGRAPH_NODES } from './subgraph'
import { asFloat, asNumber, asVector, clamp, componentWise, dot, fract, length, smoothstep } from './values'

/*
 * The engine's own node types. Math, vectors and inputs work in both kinds of graph (an `eval` here, a TSL
 * implementation in Graph/Material); the surface inputs, textures, noise and the output only in material graphs.
 */

const BOTH: GraphKind[] = ['material', 'logic']
const MATERIAL: GraphKind[] = ['material']

function n(defaultValue = 0, label?: string): PortSpec {
  return {
    type: 'number',
    default: defaultValue,
    ...(label && { label }),
  }
}
function f(defaultValue = 0, label?: string): PortSpec {
  return {
    type: 'float',
    default: defaultValue,
    ...(label && { label }),
  }
}

function unary(type: string, label: string, fn: (x: number) => number, description?: string): NodeDefinition {
  return {
    type: `math.${type}`,
    label,
    category: 'Math',
    description,
    kinds: BOTH,
    inputs: {
      x: n(),
    },
    outputs: {
      result: n(),
    },
    eval: ({ x }) => ({
      result: componentWise(fn, x),
    }),
  }
}

function binary(type: string, label: string, fn: (a: number, b: number) => number, defaults: [number, number] = [0, 0]): NodeDefinition {
  return {
    type: `math.${type}`,
    label,
    category: 'Math',
    kinds: BOTH,
    inputs: {
      a: n(defaults[0]),
      b: n(defaults[1]),
    },
    outputs: {
      result: n(),
    },
    eval: ({ a, b }) => ({
      result: componentWise(fn, a, b),
    }),
  }
}

function combine(size: 2 | 3 | 4): NodeDefinition {
  const names = ['x', 'y', 'z', 'w'].slice(0, size)
  return {
    type: `vector.combine${size}`,
    label: `Combine vec${size}`,
    category: 'Vector',
    kinds: BOTH,
    inputs: Object.fromEntries(names.map(name => [
      name,
      f(),
    ])),
    outputs: {
      vector: { type: `vec${size}` as PinType },
    },
    eval: inputs => ({
      vector: names.map(name => asFloat(inputs[name])),
    }),
  }
}

const CONSTANT_TYPES: { type: PinType, label: string, value: GraphValue }[] = [
  { type: 'float', label: 'Float', value: 0 },
  {
    type: 'vec2',
    label: 'Vec2',
    value: [0, 0],
  },
  {
    type: 'vec3',
    label: 'Vec3',
    value: [0, 0, 0],
  },
  {
    type: 'vec4',
    label: 'Vec4',
    value: [0, 0, 0, 0],
  },
  {
    type: 'color',
    label: 'Color',
    value: [1, 1, 1],
  },
]

/** A material graph's surface inputs, read per pixel (or per vertex, feeding the position offset) */
const SURFACE: { type: string, label: string, pin: PinType, description: string }[] = [
  {
    type: 'uv',
    label: 'UV',
    pin: 'vec2',
    description: 'The mesh\'s texture coordinates',
  },
  {
    type: 'positionWorld',
    label: 'World Position',
    pin: 'vec3',
    description: 'Where the surface is in the world',
  },
  {
    type: 'positionLocal',
    label: 'Local Position',
    pin: 'vec3',
    description: 'Where the surface is on the mesh, before its transform',
  },
  {
    type: 'normalWorld',
    label: 'World Normal',
    pin: 'vec3',
    description: 'The direction the surface faces, in the world',
  },
  {
    type: 'viewDirection',
    label: 'View Direction',
    pin: 'vec3',
    description: 'From the surface towards the camera, in the world',
  },
]

export const BUILTIN_NODES: NodeDefinition[] = [
  // ---- Notes
  {
    type: GRAPH_GROUP,
    label: 'Group',
    category: 'Utility',
    description: 'A named box to put nodes in, to move them together. It does nothing',
    kinds: BOTH,
    inputs: {},
    outputs: {},
    settings: {
      name: { type: 'string', default: 'Group' },
      width: { type: 'float', default: 420 },
      height: { type: 'float', default: 260 },
    },
    eval: () => ({}),
  },
  {
    type: GRAPH_COMMENT,
    label: 'Comment',
    category: 'Utility',
    description: 'A note describing the graph. It does nothing',
    kinds: BOTH,
    inputs: {},
    outputs: {},
    settings: {
      text: { type: 'string', default: '' },
      width: { type: 'float', default: 260 },
      height: { type: 'float', default: 120 },
    },
    eval: () => ({}),
  },

  // ---- Inputs
  ...CONSTANT_TYPES.map(({ type, label, value }): NodeDefinition => ({
    type: `input.${type}`,
    label,
    category: 'Input',
    kinds: BOTH,
    inputs: {},
    outputs: {
      value: { type },
    },
    settings: {
      value: { type, default: value },
    },
    eval: (_, { values }) => ({ value: values.value ?? value }),
  })),
  {
    type: 'input.parameter',
    label: 'Parameter',
    category: 'Input',
    description: 'One of the graph\'s parameters, set per use of the graph',
    kinds: BOTH,
    inputs: {},
    outputs: {
      value: { type: 'float' },
    },
    settings: {
      name: { type: 'string', default: '' },
    },
    resolveOutputs: ({ values, graph }) => {
      const parameter = graph.parameters.find(p => p.name === values.name)
      return parameter
        ? { value: parameter.type }
        : {}
    },
    eval: (_, { values, parameters }) => ({ value: parameters[String(values.name)] ?? 0 }),
  },
  {
    type: 'input.time',
    label: 'Time',
    category: 'Input',
    description: 'Seconds since the start',
    kinds: BOTH,
    inputs: {},
    outputs: {
      seconds: { type: 'float' },
    },
    eval: (_, { time }) => ({ seconds: time }),
  },
  ...SURFACE.map(({ type, label, pin, description }): NodeDefinition => ({
    type: `surface.${type}`,
    label,
    category: 'Surface',
    description,
    kinds: MATERIAL,
    inputs: {},
    outputs: {
      value: { type: pin },
    },
  })),

  // ---- Math
  binary('add', 'Add', (a, b) => a + b),
  binary('subtract', 'Subtract', (a, b) => a - b),
  binary('multiply', 'Multiply', (a, b) => a * b, [1, 1]),
  binary('divide', 'Divide', (a, b) => a / b, [1, 1]),
  binary('min', 'Min', Math.min),
  binary('max', 'Max', Math.max),
  binary('pow', 'Power', (a, b) => a ** b, [1, 1]),
  binary('step', 'Step', (edge, x) => x < edge
    ? 0
    : 1),
  unary('sin', 'Sine', Math.sin),
  unary('cos', 'Cosine', Math.cos),
  unary('abs', 'Absolute', Math.abs),
  unary('floor', 'Floor', Math.floor),
  unary('fract', 'Fraction', fract, 'The part after the decimal point: x - floor(x)'),
  unary('sqrt', 'Square Root', Math.sqrt),
  unary('negate', 'Negate', x => -x),
  unary('oneMinus', 'One Minus', x => 1 - x),
  {
    type: 'math.mix',
    label: 'Mix',
    category: 'Math',
    description: 'From a (t = 0) to b (t = 1)',
    kinds: BOTH,
    inputs: {
      a: n(0),
      b: n(1),
      t: f(0.5),
    },
    outputs: {
      result: n(),
    },
    eval: ({ a, b, t }) => ({
      result: componentWise((x, y) => x + (y - x) * asFloat(t), a, b),
    }),
  },
  {
    type: 'math.clamp',
    label: 'Clamp',
    category: 'Math',
    kinds: BOTH,
    inputs: {
      x: n(),
      min: n(0),
      max: n(1),
    },
    outputs: {
      result: n(),
    },
    eval: ({ x, min, max }) => ({
      result: componentWise(clamp, x, min, max),
    }),
  },
  {
    type: 'math.smoothstep',
    label: 'Smoothstep',
    category: 'Math',
    description: '0 below edge0, 1 above edge1, a smooth curve between',
    kinds: BOTH,
    inputs: {
      edge0: n(0),
      edge1: n(1),
      x: n(),
    },
    outputs: {
      result: n(),
    },
    eval: ({ edge0, edge1, x }) => ({
      result: componentWise(smoothstep, edge0, edge1, x),
    }),
  },
  {
    type: 'math.remap',
    label: 'Remap',
    category: 'Math',
    description: 'From one range to another: inMin maps to outMin, inMax to outMax',
    kinds: BOTH,
    inputs: {
      x: n(),
      inMin: n(0),
      inMax: n(1),
      outMin: n(0),
      outMax: n(1),
    },
    outputs: {
      result: n(),
    },
    eval: ({ x, inMin, inMax, outMin, outMax }) => ({
      result: componentWise((v, a, b, c, d) => c + (v - a) / (b - a) * (d - c), x, inMin, inMax, outMin, outMax),
    }),
  },

  // ---- Vectors
  {
    type: 'vector.length',
    label: 'Length',
    category: 'Vector',
    kinds: BOTH,
    inputs: {
      vector: n(),
    },
    outputs: {
      length: { type: 'float' },
    },
    eval: ({ vector }) => ({
      length: length(vector),
    }),
  },
  {
    type: 'vector.distance',
    label: 'Distance',
    category: 'Vector',
    kinds: BOTH,
    inputs: {
      a: n(),
      b: n(),
    },
    outputs: {
      distance: { type: 'float' },
    },
    eval: ({ a, b }) => ({
      distance: length(componentWise((x, y) => x - y, a, b)),
    }),
  },
  {
    type: 'vector.dot',
    label: 'Dot',
    category: 'Vector',
    kinds: BOTH,
    inputs: {
      a: n(),
      b: n(),
    },
    outputs: {
      result: { type: 'float' },
    },
    eval: ({ a, b }) => ({
      result: dot(a, b),
    }),
  },
  {
    type: 'vector.normalize',
    label: 'Normalize',
    category: 'Vector',
    kinds: BOTH,
    inputs: {
      vector: n(),
    },
    outputs: {
      result: n(),
    },
    eval: ({ vector }) => {
      const l = length(vector) || 1
      return {
        result: componentWise(x => x / l, vector),
      }
    },
  },
  {
    type: 'vector.cross',
    label: 'Cross',
    category: 'Vector',
    kinds: BOTH,
    inputs: {
      a: {
        type: 'vec3',
        default: [1, 0, 0],
      },
      b: {
        type: 'vec3',
        default: [0, 1, 0],
      },
    },
    outputs: {
      result: { type: 'vec3' },
    },
    eval: ({ a, b }) => {
      const [ax, ay, az] = asVector(a, 3) as [number, number, number]
      const [bx, by, bz] = asVector(b, 3) as [number, number, number]
      return {
        result: [ay * bz - az * by, az * bx - ax * bz, ax * by - ay * bx],
      }
    },
  },
  {
    type: 'vector.split',
    label: 'Split',
    category: 'Vector',
    description: 'A vector\'s components',
    kinds: BOTH,
    inputs: {
      vector: {
        type: 'number',
        default: [0, 0, 0, 0],
      },
    },
    outputs: {
      x: { type: 'float' },
      y: { type: 'float' },
      z: { type: 'float' },
      w: { type: 'float' },
    },
    eval: ({ vector }) => {
      const [x, y, z, w] = asVector(asNumber(vector), 4) as [number, number, number, number]
      return { x, y, z, w }
    },
  },
  combine(2),
  combine(3),
  combine(4),

  // ---- Material only
  {
    type: 'texture.sample',
    label: 'Texture',
    category: 'Texture',
    description: 'A texture from the game\'s resources, by its name',
    kinds: MATERIAL,
    inputs: {
      uv: { type: 'vec2', label: 'UV' },
    },
    outputs: {
      color: { type: 'vec4' },
      rgb: { type: 'color' },
      alpha: { type: 'float' },
    },
    settings: {
      texture: { type: 'string', default: '' },
    },
  },
  {
    type: 'noise.perlin3d',
    label: 'Perlin Noise',
    category: 'Noise',
    description: 'Classic 3D Perlin noise, roughly -1 .. 1',
    kinds: MATERIAL,
    inputs: {
      position: {
        type: 'vec3',
        default: [0, 0, 0],
      },
    },
    outputs: {
      value: { type: 'float' },
    },
  },
  {
    type: 'noise.value2d',
    label: 'Value Noise',
    category: 'Noise',
    description: 'Smooth 2D value noise, -1 .. 1',
    kinds: MATERIAL,
    inputs: {
      position: {
        type: 'vec2',
        default: [0, 0],
      },
    },
    outputs: {
      value: { type: 'float' },
    },
  },
  {
    type: 'material.output',
    label: 'Material Output',
    category: 'Output',
    description: 'The surface: what the material draws. Inputs left unconnected keep the material\'s defaults',
    kinds: MATERIAL,
    inputs: {
      color: {
        type: 'color',
        default: [1, 1, 1],
        label: 'Base Color',
      },
      opacity: f(1, 'Opacity'),
      roughness: f(1, 'Roughness'),
      metalness: f(0, 'Metalness'),
      emissive: {
        type: 'color',
        default: [0, 0, 0],
        label: 'Emissive',
      },
      normal: {
        type: 'vec3',
        default: [0, 0, 1],
        label: 'Normal',
      },
      positionOffset: {
        type: 'vec3',
        default: [0, 0, 0],
        label: 'Position Offset',
      },
    },
    outputs: {},
  },
]

/** Register the engine's node types. Safe to call more than once */
export function registerBuiltinNodes(): void {
  for (const node of [
    ...BUILTIN_NODES,
    ...LOGIC_NODES,
    ...SUBGRAPH_NODES,
  ])
    registerNode(node)
}
