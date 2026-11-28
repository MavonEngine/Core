import type { GraphData } from '../../src/Graph/types'
import { describe, expect, it } from 'vitest'
import { GraphRuntime } from '../../src/Graph/Logic/GraphRuntime'
import { compileMaterialGraph, registerMaterialSubgraph } from '../../src/Graph/Material/compileMaterialGraph'
import { getNode } from '../../src/Graph/NodeRegistry'
import { isFunctionGraph, loadSubgraphs, registerSubgraph, SubgraphError, subgraphType } from '../../src/Graph/Nodes/subgraph'
import { parseGraphData } from '../../src/Graph/types'

/** x * scale + 1, with scale defaulting to 2 */
function scaleAndBump(kind: 'material' | 'logic'): GraphData {
  return parseGraphData({
    kind,
    name: 'bump',
    nodes: [
      {
        id: 'x',
        type: 'graph.input',
        values: { name: 'x', type: 'float', default: 0 },
      },
      {
        id: 'scale',
        type: 'graph.input',
        values: { name: 'scale', type: 'float', default: 2 },
      },
      { id: 'mul', type: 'math.multiply' },
      {
        id: 'add',
        type: 'math.add',
        values: { b: 1 },
      },
      {
        id: 'out',
        type: 'graph.output',
        values: { name: 'result', type: 'float' },
      },
    ],
    edges: [
      {
        from: { node: 'x', port: 'value' },
        to: { node: 'mul', port: 'a' },
      },
      {
        from: { node: 'scale', port: 'value' },
        to: { node: 'mul', port: 'b' },
      },
      {
        from: { node: 'mul', port: 'result' },
        to: { node: 'add', port: 'a' },
      },
      {
        from: { node: 'add', port: 'result' },
        to: { node: 'out', port: 'value' },
      },
    ],
  })
}

describe('subgraphs', () => {
  it('become a node with a port per Graph Input and Graph Output', () => {
    const graph = scaleAndBump('logic')
    expect(isFunctionGraph(graph)).toBe(true)
    registerSubgraph('bump', graph)

    const node = getNode(subgraphType('bump'))!
    expect(node.kinds).toEqual(['logic'])
    expect(Object.keys(node.inputs)).toEqual(['x', 'scale'])
    expect(node.inputs.scale).toMatchObject({ type: 'float', default: 2 })
    expect(Object.keys(node.outputs)).toEqual(['result'])
  })

  it('work out their outputs in logic graphs, defaults filling what isn\'t connected', () => {
    registerSubgraph('bump', scaleAndBump('logic'))
    const runtime = new GraphRuntime(parseGraphData({
      kind: 'logic',
      name: 'user',
      nodes: [
        { id: 'start', type: 'event.start' },
        {
          id: 'bump',
          type: 'subgraph:bump',
          values: { x: 5 },
        },
        {
          id: 'store',
          type: 'variable.set',
          values: { name: 'v' },
        },
      ],
      edges: [
        {
          from: { node: 'start', port: 'then' },
          to: { node: 'store', port: 'run' },
        },
        {
          from: { node: 'bump', port: 'result' },
          to: { node: 'store', port: 'value' },
        },
      ],
    }))

    runtime.start()

    expect(runtime.variables.get('v')).toBe(11)
  })

  it('are inlined into materials', () => {
    registerMaterialSubgraph('bump', scaleAndBump('material'))
    const { material } = compileMaterialGraph(parseGraphData({
      kind: 'material',
      name: 'user',
      nodes: [
        { id: 'uv', type: 'surface.uv' },
        { id: 'len', type: 'vector.length' },
        { id: 'bump', type: 'subgraph:bump' },
        { id: 'out', type: 'material.output' },
      ],
      edges: [
        {
          from: { node: 'uv', port: 'value' },
          to: { node: 'len', port: 'vector' },
        },
        {
          from: { node: 'len', port: 'length' },
          to: { node: 'bump', port: 'x' },
        },
        {
          from: { node: 'bump', port: 'result' },
          to: { node: 'out', port: 'roughness' },
        },
      ],
    }))

    expect(material.roughnessNode).toBeTruthy()
  })

  it('refuse events, steps and a Material Output', () => {
    expect(() => registerSubgraph('bad', parseGraphData({
      kind: 'logic',
      name: 'bad',
      nodes: [
        { id: 'tick', type: 'event.tick' },
        {
          id: 'out',
          type: 'graph.output',
          values: { name: 'r' },
        },
      ],
    }))).toThrow(SubgraphError)
    expect(() => registerSubgraph('bad', parseGraphData({
      kind: 'material',
      name: 'bad',
      nodes: [
        { id: 'm', type: 'material.output' },
        {
          id: 'out',
          type: 'graph.output',
          values: { name: 'r' },
        },
      ],
    }))).toThrow('not a Material Output')
  })

  it('are loaded with the subgraphs they use, once each, before the graph using them', async () => {
    const outer = parseGraphData({
      kind: 'logic',
      name: 'outer',
      nodes: [
        { id: 'a', type: 'subgraph:twice' },
        { id: 'b', type: 'subgraph:twice' },
        {
          id: 'out',
          type: 'graph.output',
          values: { name: 'r' },
        },
      ],
    })
    const twice = parseGraphData({
      kind: 'logic',
      name: 'twice',
      nodes: [
        { id: 'inner', type: 'subgraph:bump' },
        {
          id: 'out',
          type: 'graph.output',
          values: { name: 'r' },
        },
      ],
    })
    const files: Record<string, GraphData> = {
      twice,
      bump: scaleAndBump('logic'),
    }
    const loaded: string[] = []
    await loadSubgraphs(outer, async (name) => {
      loaded.push(name)
      return files[name]!
    })

    expect(loaded).toEqual(['twice', 'bump'])
    expect(getNode('subgraph:twice')).toBeDefined()
  })
})
