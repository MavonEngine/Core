import type { NodeDefinition, NodeEvalContext, PortSpec } from '../NodeRegistry'
import type { GraphData, GraphKind, GraphValue, PinType } from '../types'
import type { GraphAnalysis, GraphIssue } from '../validate'
import { getNode, isStep, registerNode } from '../NodeRegistry'
import { analyzeGraph } from '../validate'
import { registerBuiltinNodes } from './builtin'

/*
 * Subgraphs: a graph with Graph Input and Graph Output nodes is a function, used as a node in other graphs of its
 * kind (`subgraph:<name>`), with a port for each input and output. They hold values only, no events or steps, so a
 * material inlines them into its shader and a logic graph works them out like any value node.
 */

const BOTH: GraphKind[] = ['material', 'logic']

export const GRAPH_INPUT = 'graph.input'
export const GRAPH_OUTPUT = 'graph.output'

const PORT_TYPES: PinType[] = [
  'float',
  'vec2',
  'vec3',
  'vec4',
  'color',
  'bool',
  'string',
  'entity',
]

/** The ends of a subgraph: what it takes and what it gives */
export const SUBGRAPH_NODES: NodeDefinition[] = [
  {
    type: GRAPH_INPUT,
    label: 'Graph Input',
    category: 'Subgraph',
    description: 'A value this graph takes when used as a node in another graph',
    kinds: BOTH,
    inputs: {},
    outputs: {
      value: { type: 'any' },
    },
    settings: {
      name: { type: 'string', default: 'in' },
      type: { type: 'string', default: 'float' },
      default: { type: 'float', default: 0 },
    },
    resolveOutputs: ({ values }) => ({
      value: portType(values.type),
    }),
    // Only inside a subgraph, where it gets what was passed in. See evaluateSubgraph()
    eval: (_, { values }) => ({ value: values.default ?? 0 }),
  },
  {
    type: GRAPH_OUTPUT,
    label: 'Graph Output',
    category: 'Subgraph',
    description: 'A value this graph gives when used as a node in another graph',
    kinds: BOTH,
    inputs: {
      value: { type: 'any', default: 0 },
    },
    outputs: {},
    settings: {
      name: { type: 'string', default: 'out' },
      type: { type: 'string', default: 'float' },
    },
    eval: () => ({}),
  },
]

function portType(value: GraphValue | undefined): PinType {
  return PORT_TYPES.includes(value as PinType)
    ? value as PinType
    : 'float'
}

/** A function graph's node type */
export function subgraphType(name: string): string {
  return `subgraph:${name}`
}

/** The graph a subgraph node type uses, undefined for other node types */
export function subgraphName(type: string): string | undefined {
  return type.startsWith('subgraph:')
    ? type.slice('subgraph:'.length)
    : undefined
}

/** Whether a graph is a function, used as a node in other graphs: it has a Graph Output */
export function isFunctionGraph(graph: Pick<GraphData, 'nodes'>): boolean {
  return graph.nodes.some(node => node.type === GRAPH_OUTPUT)
}

/** A subgraph's ports, from its Graph Input and Graph Output nodes */
function subgraphPorts(graph: GraphData) {
  const inputs: Record<string, PortSpec> = {}
  const outputs: Record<string, PortSpec> = {}
  for (const node of graph.nodes) {
    const name = String(node.values?.name ?? (node.type === GRAPH_INPUT
      ? 'in'
      : 'out'))
    if (node.type === GRAPH_INPUT) {
      inputs[name] = {
        type: portType(node.values?.type),
        default: node.values?.default ?? 0,
      }
    }
    if (node.type === GRAPH_OUTPUT) {
      outputs[name] = {
        type: portType(node.values?.type),
      }
    }
  }
  return { inputs, outputs }
}

/** What keeps a graph from being a subgraph */
export function subgraphIssues(graph: GraphData, analysis: GraphAnalysis = analyzeGraph(graph)): GraphIssue[] {
  const issues = [...analysis.issues]
  const names = new Map<string, number>()
  for (const node of graph.nodes) {
    const definition = getNode(node.type)
    if (definition && isStep(definition))
      issues.push({ node: node.id, message: `${definition.label} can't be in a subgraph: subgraphs work out values, they have no events or steps` })
    if (node.type === 'material.output')
      issues.push({ node: node.id, message: 'A subgraph gives its values through Graph Output nodes, not a Material Output' })
    if (node.type === GRAPH_INPUT || node.type === GRAPH_OUTPUT) {
      const key = `${node.type}:${node.values?.name ?? ''}`
      names.set(key, (names.get(key) ?? 0) + 1)
      if (names.get(key) === 2) {
        issues.push({ node: node.id, message: `Two ${node.type === GRAPH_INPUT
          ? 'inputs'
          : 'outputs'} are named "${node.values?.name ?? ''}"` })
      }
    }
  }
  return issues
}

export class SubgraphError extends Error {
  constructor(readonly graph: string, readonly issues: GraphIssue[]) {
    super(`Subgraph "${graph}" has problems:\n${issues.map(issue => `  - ${issue.node
      ? `${issue.node}: `
      : ''}${issue.message}`).join('\n')}`)
    this.name = 'SubgraphError'
  }
}

/** Subgraphs being worked out, to refuse one that uses itself */
const evaluating = new Set<string>()

/**
 * A subgraph's outputs from its inputs, for logic graphs: its value nodes worked out in order, its Graph Inputs giving
 * what was passed in
 */
export function evaluateSubgraph(name: string, graph: GraphData, analysis: GraphAnalysis, inputs: Record<string, GraphValue>, context: NodeEvalContext): Record<string, GraphValue> {
  if (evaluating.has(name))
    throw new Error(`Subgraph "${name}" uses itself`)
  evaluating.add(name)
  try {
    const values = new Map<string, Record<string, GraphValue>>()
    const outputs: Record<string, GraphValue> = {}
    for (const node of analysis.order) {
      const definition = getNode(node.type)!
      const edges = analysis.incoming.get(node.id) ?? {}
      const nodeInputs: Record<string, GraphValue> = {}
      for (const [port, spec] of Object.entries(definition.inputs)) {
        const edge = edges[port]
        const value = edge
          ? values.get(edge.from.node)?.[edge.from.port]
          : node.values?.[port] ?? spec.default
        if (value !== undefined)
          nodeInputs[port] = value
      }

      const nodeName = String(node.values?.name ?? '')
      if (node.type === GRAPH_INPUT) {
        values.set(node.id, { value: inputs[nodeName] ?? node.values?.default ?? 0 })
        continue
      }
      if (node.type === GRAPH_OUTPUT) {
        outputs[nodeName] = nodeInputs.value ?? 0
        continue
      }
      values.set(node.id, definition.eval!(nodeInputs, { ...context, values: node.values ?? {} }))
    }
    return outputs
  }
  finally {
    evaluating.delete(name)
  }
}

/**
 * Make the graph `name` usable as a node (`subgraph:<name>`) in other graphs of its kind. Throws a SubgraphError when
 * it can't be one. Registering it again (after an edit) replaces it, ports and all
 */
export function registerSubgraph(name: string, graph: GraphData): NodeDefinition {
  registerBuiltinNodes()
  const analysis = analyzeGraph(graph)
  const issues = subgraphIssues(graph, analysis)
  if (issues.length)
    throw new SubgraphError(name, issues)

  const { inputs, outputs } = subgraphPorts(graph)
  const definition: NodeDefinition = {
    type: subgraphType(name),
    label: name.split(':').pop()!,
    category: 'Subgraphs',
    description: `The subgraph ${name}`,
    kinds: [graph.kind],
    inputs,
    outputs,
    eval: (values, context) => evaluateSubgraph(name, graph, analysis, values, context),
  }
  registerNode(definition)
  return definition
}

/**
 * Register the subgraphs `graph` uses, and the ones they use, loading each with `load`. Resolves once all are
 * registered; one that can't be loaded or used leaves its nodes unknown, which the graph then reports
 */
export async function loadSubgraphs(graph: GraphData, load: (name: string) => Promise<GraphData>, register: (name: string, graph: GraphData) => void = registerSubgraph, seen = new Set<string>()): Promise<void> {
  const names = [
    ...new Set(graph.nodes.map(node => subgraphName(node.type)).filter((name): name is string => !!name)),
  ]
  await Promise.all(names.filter(name => !seen.has(name)).map(async (name) => {
    seen.add(name)
    try {
      const subgraph = await load(name)
      await loadSubgraphs(subgraph, load, register, seen)
      register(name, subgraph)
    }
    catch {
      // Reported by the graph using it, as an unknown node
    }
  }))
}
