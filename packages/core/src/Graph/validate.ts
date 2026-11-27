import type { NodeDefinition } from './NodeRegistry'
import type { GraphData, GraphEdgeData, GraphNodeData, GraphValue, PinType } from './types'
import { canConnect, getNode, widestType } from './NodeRegistry'

export interface GraphIssue {
  message: string
  /** The node it's about, if any */
  node?: string
  port?: string
}

/** A graph checked against the registered node types */
export interface GraphAnalysis {
  issues: GraphIssue[]
  /** Every node's output types, by node id then port */
  outputTypes: Map<string, Record<string, PinType>>
  /** The edge into each input, by node id then port */
  incoming: Map<string, Record<string, GraphEdgeData>>
  /** The nodes in an order where each comes after the nodes its values come from. Nodes in a cycle are left out */
  order: GraphNodeData[]
}

/** The type of a value written in the graph file */
export function typeOfValue(value: GraphValue | undefined): PinType | undefined {
  if (typeof value === 'number')
    return 'float'
  if (typeof value === 'boolean')
    return 'bool'
  if (typeof value === 'string')
    return 'string'
  if (Array.isArray(value)) {
    if (value.length === 2)
      return 'vec2'
    if (value.length === 3)
      return 'vec3'
    if (value.length === 4)
      return 'vec4'
  }
  return undefined
}

/** The type an input gets while nothing is connected: its value's, or its port's when that is fixed */
function unconnectedType(definition: NodeDefinition, port: string, node: GraphNodeData): PinType {
  const spec = definition.inputs[port]!
  const value = node.values?.[port] ?? spec.default
  if (spec.type !== 'number')
    return spec.type
  return typeOfValue(value) ?? 'float'
}

/**
 * Check a graph against the registered node types: unknown types and ports, nodes that don't belong in this kind of
 * graph, inputs with two edges, types that don't fit and cycles. Also works out the type of every output.
 */
export function analyzeGraph(graph: GraphData): GraphAnalysis {
  const issues: GraphIssue[] = []
  const nodes = new Map(graph.nodes.map(node => [node.id, node]))
  const definitions = new Map<string, NodeDefinition>()

  for (const node of graph.nodes) {
    const definition = getNode(node.type)
    if (!definition) {
      issues.push({ node: node.id, message: `Unknown node type "${node.type}"` })
      continue
    }
    if (!definition.kinds.includes(graph.kind))
      issues.push({ node: node.id, message: `${definition.label} can't be used in a ${graph.kind} graph` })
    definitions.set(node.id, definition)
  }

  const incoming = new Map<string, Record<string, GraphEdgeData>>()
  // Value dependencies: exec edges order the steps of a logic graph, they don't carry values
  const dependsOn = new Map<string, Set<string>>(graph.nodes.map(node => [
    node.id,
    new Set(),
  ]))

  for (const edge of graph.edges) {
    const from = definitions.get(edge.from.node)
    const to = definitions.get(edge.to.node)
    if (!nodes.has(edge.from.node) || !nodes.has(edge.to.node)) {
      issues.push({ message: `An edge connects a missing node (${edge.from.node} → ${edge.to.node})` })
      continue
    }
    if (!from || !to)
      continue
    if (!from.outputs[edge.from.port]) {
      issues.push({ node: edge.from.node, port: edge.from.port, message: `${from.label} has no output "${edge.from.port}"` })
      continue
    }
    if (!to.inputs[edge.to.port]) {
      issues.push({ node: edge.to.node, port: edge.to.port, message: `${to.label} has no input "${edge.to.port}"` })
      continue
    }
    const ports = incoming.get(edge.to.node) ?? {}
    if (ports[edge.to.port]) {
      issues.push({ node: edge.to.node, port: edge.to.port, message: `${to.label}'s input "${edge.to.port}" has more than one edge` })
      continue
    }
    ports[edge.to.port] = edge
    incoming.set(edge.to.node, ports)
    if (from.outputs[edge.from.port]!.type !== 'exec')
      dependsOn.get(edge.to.node)!.add(edge.from.node)
  }

  // Kahn's algorithm: what's left at the end is in a cycle
  const order: GraphNodeData[] = []
  const waiting = new Map([...dependsOn].map(([id, deps]) => [id, deps.size]))
  const ready = graph.nodes.filter(node => waiting.get(node.id) === 0).map(node => node.id)
  while (ready.length) {
    const id = ready.shift()!
    order.push(nodes.get(id)!)
    for (const [other, deps] of dependsOn) {
      if (deps.has(id)) {
        const left = waiting.get(other)! - 1
        waiting.set(other, left)
        if (left === 0)
          ready.push(other)
      }
    }
  }
  const cyclic = graph.nodes.filter(node => !order.includes(node))
  if (cyclic.length)
    issues.push({ message: `These nodes depend on each other in a loop: ${cyclic.map(node => node.id).join(', ')}` })

  const outputTypes = new Map<string, Record<string, PinType>>()
  for (const node of order) {
    const definition = definitions.get(node.id)
    if (!definition)
      continue

    const edges = incoming.get(node.id) ?? {}
    const inputs: Record<string, PinType> = {}
    for (const [port, spec] of Object.entries(definition.inputs)) {
      const edge = edges[port]
      const arriving = edge && outputTypes.get(edge.from.node)?.[edge.from.port]
      if (edge && !arriving)
        continue
      const type = arriving ?? unconnectedType(definition, port, node)
      inputs[port] = type
      if (arriving && !canConnect(arriving, spec.type))
        issues.push({ node: node.id, port, message: `${definition.label}'s input "${port}" takes ${spec.type}, not ${arriving}` })
    }

    const numberInputs = Object.entries(definition.inputs)
      .filter(([port, spec]) => spec.type === 'number' && inputs[port])
      .map(([port]) => inputs[port]!)
    const resolved = definition.resolveOutputs?.({ inputs, values: node.values ?? {}, graph }) ?? {}

    const outputs: Record<string, PinType> = {}
    for (const [port, spec] of Object.entries(definition.outputs)) {
      outputs[port] = resolved[port]
        ?? (spec.type === 'number'
          ? widestType(numberInputs)
          : spec.type)
    }
    outputTypes.set(node.id, outputs)
  }

  return { issues, outputTypes, incoming, order }
}
