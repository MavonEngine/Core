import { describe, expect, it } from 'vitest'
import { defaultMaterialGraph, fromFlow, graphKey, newNodeId, toFlow } from '../../../src/Editor/UI/Graphs/graphModel'

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

describe('comments', () => {
  it('don\'t change the graph\'s key, and keep their size', () => {
    const graph = defaultMaterialGraph('stone')
    const noted = {
      ...graph,
      nodes: [
        ...graph.nodes,
        {
          id: 'note',
          type: 'graph.comment',
          position: [0, 0] as [number, number],
          values: { text: 'Grey stone', width: 300, height: 90 },
        },
      ],
    }

    expect(graphKey(noted)).toBe(graphKey(graph))
    expect(toFlow(noted).nodes.find(node => node.id === 'note')).toMatchObject({ width: 300, height: 90, zIndex: -1 })
  })
})

describe('groups', () => {
  const grouped = () => {
    const graph = defaultMaterialGraph('stone')
    return {
      ...graph,
      nodes: [
        {
          ...graph.nodes[0]!,
          position: [150, 120] as [number, number],
          group: 'box',
        },
        graph.nodes[1]!,
        {
          id: 'box',
          type: 'graph.group',
          position: [100, 50] as [number, number],
          values: { name: 'Base color', width: 300, height: 200 },
        },
      ],
    }
  }

  it('put a group before its nodes, which sit relative to it in the editor', () => {
    const { nodes } = toFlow(grouped())

    expect(nodes[0]).toMatchObject({
      id: 'box',
      width: 300,
      height: 200,
      zIndex: -2,
    })
    expect(nodes.find(node => node.id === 'color_1')).toMatchObject({
      parentId: 'box',
      position: { x: 50, y: 70 },
    })
  })

  it('keep canvas positions and who is in which group in the file', () => {
    const graph = grouped()
    const { nodes, edges } = toFlow(graph)
    const back = fromFlow(graph, nodes, edges, graph.parameters)

    expect(back.nodes.find(node => node.id === 'color_1')).toEqual(expect.objectContaining({
      position: [150, 120],
      group: 'box',
    }))
    expect(back.nodes.find(node => node.id === 'output')!.group).toBeUndefined()
  })

  it('don\'t change the graph\'s key', () => {
    const graph = defaultMaterialGraph('stone')
    expect(graphKey(grouped())).toBe(graphKey({ ...graph, nodes: graph.nodes }))
  })
})
