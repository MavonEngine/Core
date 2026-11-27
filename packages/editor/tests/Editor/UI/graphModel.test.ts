import { describe, expect, it } from 'vitest'
import { defaultMaterialGraph, fromFlow, graphKey, newNodeId, toFlow } from '../../../src/Editor/UI/Materials/graphModel'

describe('graph model', () => {
  it('goes to React Flow and back without changing the graph', () => {
    const graph = defaultMaterialGraph('stone')
    const { nodes, edges } = toFlow(graph)

    expect(edges[0]).toMatchObject({
      source: 'color_1',
      sourceHandle: 'value',
      target: 'output',
      targetHandle: 'color',
    })
    expect(fromFlow(graph, nodes, edges, graph.parameters)).toEqual(graph)
  })

  it('keys a graph by what it compiles to, not where its nodes sit', () => {
    const graph = defaultMaterialGraph('stone')
    const moved = {
      ...graph,
      nodes: graph.nodes.map(node => ({
        ...node,
        position: [500, 500] as [number, number],
      })),
    }
    const recolored = {
      ...graph,
      nodes: graph.nodes.map(node => ({
        ...node,
        values: {
          value: [1, 0, 0],
        },
      })),
    }

    expect(graphKey(moved)).toBe(graphKey(graph))
    expect(graphKey(recolored)).not.toBe(graphKey(graph))
  })

  it('names new nodes after their type, without taking an id', () => {
    expect(newNodeId('math.add', [])).toBe('add_1')
    expect(newNodeId('math.add', ['add_1', 'add_2'])).toBe('add_3')
  })
})
