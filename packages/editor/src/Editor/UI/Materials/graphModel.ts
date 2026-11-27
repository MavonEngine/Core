import type { GraphData, GraphEdgeData, GraphParameter, GraphValue, PinType } from '@mavonengine/core/Graph/types'
import type { Edge, Node } from '@xyflow/react'
import { GRAPH_FORMAT_VERSION } from '@mavonengine/core/Graph/types'

/*
 * Between a graph file and React Flow's nodes and edges. React Flow holds the nodes (with their positions and
 * selection) while the editor runs; the graph file is made from them to compile and save.
 */

export interface GraphNodeFields extends Record<string, unknown> {
  type: string
  values: Record<string, GraphValue>
}

export type FlowNode = Node<GraphNodeFields, 'graph'>
export type FlowEdge = Edge

export function edgeId(edge: GraphEdgeData): string {
  return `${edge.from.node}:${edge.from.port}->${edge.to.node}:${edge.to.port}`
}

export function toFlow(graph: GraphData): { nodes: FlowNode[], edges: FlowEdge[] } {
  return {
    nodes: graph.nodes.map(node => ({
      id: node.id,
      type: 'graph',
      position: { x: node.position[0], y: node.position[1] },
      data: {
        type: node.type,
        values: { ...node.values },
      },
    })),
    edges: graph.edges.map(edge => ({
      id: edgeId(edge),
      source: edge.from.node,
      sourceHandle: edge.from.port,
      target: edge.to.node,
      targetHandle: edge.to.port,
    })),
  }
}

export function fromFlow(base: Pick<GraphData, 'name' | 'kind'>, nodes: FlowNode[], edges: FlowEdge[], parameters: GraphParameter[]): GraphData {
  return {
    version: GRAPH_FORMAT_VERSION,
    kind: base.kind,
    name: base.name,
    nodes: nodes.map(node => ({
      id: node.id,
      type: node.data.type,
      position: [
        Math.round(node.position.x),
        Math.round(node.position.y),
      ],
      ...(Object.keys(node.data.values).length && {
        values: { ...node.data.values },
      }),
    })),
    edges: edges.map(edge => ({
      from: { node: edge.source, port: edge.sourceHandle ?? '' },
      to: { node: edge.target, port: edge.targetHandle ?? '' },
    })),
    parameters,
  }
}

/** What changes what the graph compiles to: everything except where the nodes sit and what is selected */
export function graphKey(graph: GraphData): string {
  return JSON.stringify({
    nodes: graph.nodes.map(node => [node.id, node.type, node.values]),
    edges: graph.edges,
    parameters: graph.parameters,
  })
}

/** A new node id from its type, e.g. `add_3`, not taken by `existing` */
export function newNodeId(type: string, existing: Iterable<string>): string {
  const taken = new Set(existing)
  const base = (type.split('.').pop() ?? 'node').replace(/\W/g, '')
  let n = 1
  while (taken.has(`${base}_${n}`))
    n++
  return `${base}_${n}`
}

/** A new material graph: a color into the output */
export function defaultMaterialGraph(name: string): GraphData {
  return {
    version: GRAPH_FORMAT_VERSION,
    kind: 'material',
    name,
    nodes: [
      {
        id: 'color_1',
        type: 'input.color',
        position: [0, 0],
        values: {
          value: [0.8, 0.8, 0.8],
        },
      },
      {
        id: 'output',
        type: 'material.output',
        position: [320, 0],
      },
    ],
    edges: [
      {
        from: { node: 'color_1', port: 'value' },
        to: { node: 'output', port: 'color' },
      },
    ],
    parameters: [],
  }
}

/** A parameter's starting value for its type */
export function defaultValue(type: PinType): GraphValue {
  switch (type) {
    case 'vec2':
      return [0, 0]
    case 'vec3':
      return [0, 0, 0]
    case 'vec4':
      return [0, 0, 0, 0]
    case 'color':
      return [1, 1, 1]
    case 'bool':
      return false
    case 'string':
    case 'texture':
      return ''
    default:
      return 0
  }
}

/** The colors the editor draws ports and edges of each type in */
export const PIN_COLORS: Record<PinType | 'number', string> = {
  float: '#8fb3ff',
  int: '#5fd1c1',
  bool: '#e06c75',
  vec2: '#c99cff',
  vec3: '#f0c674',
  vec4: '#f59e6b',
  color: '#ffd84d',
  texture: '#e5c07b',
  string: '#9ca3af',
  entity: '#56b6c2',
  exec: '#ffffff',
  number: '#a5b4fc',
}
