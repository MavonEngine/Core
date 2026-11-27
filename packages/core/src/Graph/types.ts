/**
 * The JSON format of a node graph file (`graphs/<name>.graph.json` in the project root), shared by material graphs
 * (compiled to TSL) and logic graphs (run by the engine). Nothing here depends on three.js, so the server loads it too.
 */

export const GRAPH_FORMAT_VERSION = 1

/** Directory in the project root (next to `scenes/`) that holds the graph files */
export const GRAPHS_DIR = 'graphs'

/** Graph file names: letters, digits, `-` and `_` */
export const GRAPH_NAME_RE = /^[\w-]+$/

export type GraphKind = 'material' | 'logic'

/**
 * What flows along an edge. `exec` connects logic graph steps in order, the others carry values.
 * `color` is a vec3 the editor shows as a color.
 */
export type PinType
  = | 'float'
    | 'int'
    | 'bool'
    | 'vec2'
    | 'vec3'
    | 'vec4'
    | 'color'
    | 'texture'
    | 'string'
    | 'entity'
    | 'exec'

/**
 * A port's type: one pin type, or `number` for any of float and the vectors. A node whose ports are `number` works
 * component wise, and its `number` outputs take the widest of its `number` inputs' types (float + vec3 gives vec3).
 */
export type PortType = PinType | 'number'

export type GraphValue = number | boolean | string | number[]

export interface GraphNodeData {
  /** Unique within the graph */
  id: string
  /** Key of a registered node type, see `registerNode()` */
  type: string
  /** Where the editor draws it */
  position: [number, number]
  /** Values of the inputs that have no edge, and the node's settings, by port name */
  values?: Record<string, GraphValue>
}

export interface GraphEndpoint {
  node: string
  port: string
}

export interface GraphEdgeData {
  /** Out of an output port */
  from: GraphEndpoint
  /** Into an input port. An input takes at most one edge, outputs can feed many */
  to: GraphEndpoint
}

/** A value the graph exposes, set per use (a material instance, a logic component) */
export interface GraphParameter {
  name: string
  type: PinType
  default: GraphValue
}

export interface GraphData {
  version: number
  kind: GraphKind
  name: string
  nodes: GraphNodeData[]
  edges: GraphEdgeData[]
  parameters: GraphParameter[]
}

const KINDS: GraphKind[] = ['material', 'logic']

function isVec2(v: unknown): v is [number, number] {
  return Array.isArray(v) && v.length === 2 && v.every(n => typeof n === 'number')
}

function endpoint(value: unknown, where: string): GraphEndpoint {
  const e = value as Partial<GraphEndpoint> | undefined
  if (!e || typeof e.node !== 'string' || typeof e.port !== 'string')
    throw new Error(`${where} needs a "node" and a "port"`)
  return { node: e.node, port: e.port }
}

/**
 * Check that `value` looks like a graph file and fill in what may be left out. Throws with a readable message when
 * it doesn't. Only checks the shape: `validateGraph()` checks it against the registered node types.
 */
export function parseGraphData(value: unknown, fallbackName = 'untitled'): GraphData {
  if (!value || typeof value !== 'object')
    throw new Error('Graph must be a JSON object')

  const raw = value as Partial<GraphData>
  if (raw.version !== undefined && raw.version > GRAPH_FORMAT_VERSION)
    throw new Error(`Graph format version ${raw.version} is newer than this engine supports (${GRAPH_FORMAT_VERSION})`)
  if (!raw.kind || !KINDS.includes(raw.kind))
    throw new Error(`Graph "kind" must be one of ${KINDS.join(', ')}`)

  for (const key of ['nodes', 'edges', 'parameters'] as const) {
    if (raw[key] !== undefined && !Array.isArray(raw[key]))
      throw new Error(`Graph "${key}" must be an array`)
  }

  const ids = new Set<string>()
  const nodes = (raw.nodes ?? []).map((node, index): GraphNodeData => {
    if (!node || typeof node !== 'object' || typeof node.type !== 'string' || !node.type)
      throw new Error(`Graph node ${index} needs a "type"`)
    if (typeof node.id !== 'string' || !node.id)
      throw new Error(`Graph node ${index} (${node.type}) needs an "id"`)
    if (ids.has(node.id))
      throw new Error(`Graph node id "${node.id}" is used twice`)
    ids.add(node.id)
    if (node.values !== undefined && (typeof node.values !== 'object' || Array.isArray(node.values)))
      throw new Error(`Graph node ${node.id}: "values" must be an object`)

    return {
      id: node.id,
      type: node.type,
      position: isVec2(node.position)
        ? [node.position[0], node.position[1]]
        : [0, 0],
      ...(node.values && {
        values: { ...node.values },
      }),
    }
  })

  const edges = (raw.edges ?? []).map((edge, index): GraphEdgeData => ({
    from: endpoint(edge?.from, `Graph edge ${index} "from"`),
    to: endpoint(edge?.to, `Graph edge ${index} "to"`),
  }))

  const parameters = (raw.parameters ?? []).map((parameter, index): GraphParameter => {
    if (!parameter || typeof parameter.name !== 'string' || !parameter.name || typeof parameter.type !== 'string')
      throw new Error(`Graph parameter ${index} needs a "name" and a "type"`)
    return { name: parameter.name, type: parameter.type, default: parameter.default ?? 0 }
  })

  return {
    version: GRAPH_FORMAT_VERSION,
    kind: raw.kind,
    name: typeof raw.name === 'string' && raw.name
      ? raw.name
      : fallbackName,
    nodes,
    edges,
    parameters,
  }
}
