import type { GraphData } from '../../src/Graph/types'
import { Color, Texture } from 'three'
import { describe, expect, it } from 'vitest'
import { compileMaterialGraph, MaterialGraphError } from '../../src/Graph/Material/compileMaterialGraph'
import { parseGraphData } from '../../src/Graph/types'

function graph(partial: Partial<GraphData>): GraphData {
  return parseGraphData({ kind: 'material', name: 'lava', ...partial })
}

const lava = graph({
  parameters: [
    {
      name: 'tint',
      type: 'color',
      default: [1, 0.3, 0],
    },
    { name: 'speed', type: 'float', default: 1 },
  ],
  nodes: [
    {
      id: 'out',
      type: 'material.output',
      position: [0, 0],
    },
    {
      id: 'tint',
      type: 'input.parameter',
      position: [0, 0],
      values: { name: 'tint' },
    },
    {
      id: 'speed',
      type: 'input.parameter',
      position: [0, 0],
      values: { name: 'speed' },
    },
    {
      id: 'time',
      type: 'input.time',
      position: [0, 0],
    },
    {
      id: 'phase',
      type: 'math.multiply',
      position: [0, 0],
    },
    {
      id: 'wave',
      type: 'math.sin',
      position: [0, 0],
    },
    {
      id: 'glow',
      type: 'math.multiply',
      position: [0, 0],
    },
    {
      id: 'tex',
      type: 'texture.sample',
      position: [0, 0],
      values: { texture: 'rock' },
    },
  ],
  edges: [
    {
      from: { node: 'time', port: 'seconds' },
      to: { node: 'phase', port: 'a' },
    },
    {
      from: { node: 'speed', port: 'value' },
      to: { node: 'phase', port: 'b' },
    },
    {
      from: { node: 'phase', port: 'result' },
      to: { node: 'wave', port: 'x' },
    },
    {
      from: { node: 'tint', port: 'value' },
      to: { node: 'glow', port: 'a' },
    },
    {
      from: { node: 'wave', port: 'result' },
      to: { node: 'glow', port: 'b' },
    },
    {
      from: { node: 'glow', port: 'result' },
      to: { node: 'out', port: 'emissive' },
    },
    {
      from: { node: 'tex', port: 'rgb' },
      to: { node: 'out', port: 'color' },
    },
  ],
})

describe('compileMaterialGraph', () => {
  it('sets the material\'s nodes for the connected outputs only', () => {
    const rock = new Texture()
    const { material } = compileMaterialGraph(lava, {
      textures: name => name === 'rock'
        ? rock
        : undefined,
    })

    expect(material.name).toBe('lava')
    expect(material.colorNode).toBeTruthy()
    expect(material.emissiveNode).toBeTruthy()
    expect(material.roughnessNode).toBeNull()
    expect(material.positionNode).toBeNull()
    expect(material.transparent).toBe(false)
  })

  it('makes a uniform per parameter, starting at the given value or the default', () => {
    const { parameters } = compileMaterialGraph(lava, {
      parameters: { speed: 3 },
    })
    expect(parameters.speed!.value).toBe(3)
    expect(parameters.tint!.value).toBeInstanceOf(Color)
    expect((parameters.tint!.value as Color).toArray()).toEqual([1, 0.3, 0])
  })

  it('splits a vector of any size, 0 for the components it hasn\'t', () => {
    const { material } = compileMaterialGraph(graph({
      nodes: [
        {
          id: 'uv',
          type: 'surface.uv',
          position: [0, 0],
        },
        {
          id: 'split',
          type: 'vector.split',
          position: [0, 0],
        },
        {
          id: 'out',
          type: 'material.output',
          position: [0, 0],
        },
      ],
      edges: [
        {
          from: { node: 'uv', port: 'value' },
          to: { node: 'split', port: 'vector' },
        },
        {
          from: { node: 'split', port: 'z' },
          to: { node: 'out', port: 'metalness' },
        },
        {
          from: { node: 'split', port: 'y' },
          to: { node: 'out', port: 'roughness' },
        },
      ],
    }))
    expect(material.roughnessNode).toBeTruthy()
    expect(material.metalnessNode).toBeTruthy()
  })

  it('throws with every problem in the graph', () => {
    expect(() => compileMaterialGraph(graph({}))).toThrow(MaterialGraphError)
    expect(() => compileMaterialGraph(graph({}))).toThrow('exactly one Material Output node, it has 0')
    expect(() => compileMaterialGraph(graph({
      nodes: [
        {
          id: 'out',
          type: 'material.output',
          position: [0, 0],
        },
        {
          id: 'x',
          type: 'unknown.node',
          position: [0, 0],
        },
      ],
    }))).toThrow('x: Unknown node type "unknown.node"')
    expect(() => compileMaterialGraph(parseGraphData({ kind: 'logic', name: 'ai' }))).toThrow('It is a logic graph')
  })
})
