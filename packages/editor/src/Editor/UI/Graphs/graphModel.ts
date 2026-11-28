import type { GraphData, GraphEdgeData, GraphParameter, GraphValue, PinType } from '@mavonengine/core/Graph/types'
import type { Edge, Node } from '@xyflow/react'
import { GRAPH_COMMENT, GRAPH_FORMAT_VERSION, GRAPH_GROUP } from '@mavonengine/core/Graph/types'

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

/** A comment's size, and behind the nodes it describes */
export function commentLayout(values: Record<string, GraphValue> | undefined) {
  return {
    width: Number(values?.width ?? 260),
    height: Number(values?.height ?? 120),
    zIndex: -1,
  }
}

/** A group's size, behind everything else */
export function groupLayout(values: Record<string, GraphValue> | undefined) {
  return {
    width: Number(values?.width ?? 420),
    height: Number(values?.height ?? 260),
    zIndex: -2,
  }
}

/** Groups first: React Flow needs a parent before the nodes in it */
export function groupsFirst<T extends { data: { type: string } }>(nodes: T[]): T[] {
  return [
    ...nodes.filter(node => node.data.type === GRAPH_GROUP),
    ...nodes.filter(node => node.data.type !== GRAPH_GROUP),
  ]
}

/**
 * React Flow's nodes and edges for a graph. A node in a group is the group's child there, placed relative to it, so
 * it moves with the group; the graph file keeps every position as it is on the canvas
 */
export function toFlow(graph: GraphData): { nodes: FlowNode[], edges: FlowEdge[] } {
  const groups = new Map(graph.nodes.filter(node => node.type === GRAPH_GROUP).map(node => [node.id, node]))
  const nodes = graph.nodes.map((node): FlowNode => {
    const group = node.group && node.type !== GRAPH_GROUP
      ? groups.get(node.group)
      : undefined
    return {
      id: node.id,
      type: 'graph',
      position: group
        ? { x: node.position[0] - group.position[0], y: node.position[1] - group.position[1] }
        : { x: node.position[0], y: node.position[1] },
      data: {
        type: node.type,
        values: { ...node.values },
      },
      ...(group && { parentId: group.id }),
      ...(node.type === GRAPH_COMMENT && commentLayout(node.values)),
      ...(node.type === GRAPH_GROUP && groupLayout(node.values)),
    }
  })
  return {
    nodes: groupsFirst(nodes),
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
  const byId = new Map(nodes.map(node => [node.id, node]))
  return {
    version: GRAPH_FORMAT_VERSION,
    kind: base.kind,
    name: base.name,
    nodes: nodes.map((node) => {
      // Back to where it is on the canvas: a group's child is placed relative to the group
      const group = node.parentId
        ? byId.get(node.parentId)
        : undefined
      const x = node.position.x + (group?.position.x ?? 0)
      const y = node.position.y + (group?.position.y ?? 0)
      return {
        id: node.id,
        type: node.data.type,
        position: [
          Math.round(x),
          Math.round(y),
        ] as [number, number],
        ...(Object.keys(node.data.values).length && {
          values: { ...node.data.values },
        }),
        ...(group && { group: group.id }),
      }
    }),
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
    // Comments and groups change nothing the graph does
    nodes: graph.nodes.filter(node => node.type !== GRAPH_COMMENT && node.type !== GRAPH_GROUP).map(node => [node.id, node.type, node.values]),
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

/** A new logic graph: On Start logs a hello */
export function defaultLogicGraph(name: string): GraphData {
  return {
    version: GRAPH_FORMAT_VERSION,
    kind: 'logic',
    name,
    nodes: [
      {
        id: 'start_1',
        type: 'event.start',
        position: [0, 0],
      },
      {
        id: 'log_1',
        type: 'action.log',
        position: [260, 0],
        values: { value: `${name} started` },
      },
    ],
    edges: [
      {
        from: { node: 'start_1', port: 'then' },
        to: { node: 'log_1', port: 'run' },
      },
    ],
    parameters: [],
  }
}

/** A new subgraph: one input handed straight to one output, to build on */
export function defaultSubgraph(name: string, kind: GraphData['kind']): GraphData {
  return {
    version: GRAPH_FORMAT_VERSION,
    kind,
    name,
    nodes: [
      {
        id: 'in_1',
        type: 'graph.input',
        position: [0, 0],
        values: { name: 'in', type: 'float', default: 0 },
      },
      {
        id: 'out_1',
        type: 'graph.output',
        position: [320, 0],
        values: { name: 'out', type: 'float' },
      },
    ],
    edges: [
      {
        from: { node: 'in_1', port: 'value' },
        to: { node: 'out_1', port: 'value' },
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
export const PIN_COLORS: Record<PinType | 'number' | 'any', string> = {
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
  any: '#d4d4d8',
}
