import type { Texture } from 'three'
import type { GraphData, GraphNodeData, GraphParameter, GraphValue, PinType } from '../types'
import type { GraphAnalysis, GraphIssue } from '../validate'
import type { TslNode, TslNodeContext } from './tslNodes'
import { uniform } from 'three/tsl'
import { Color, MeshStandardNodeMaterial, Vector2, Vector3, Vector4 } from 'three/webgpu'
import { getNode } from '../NodeRegistry'
import { registerBuiltinNodes } from '../Nodes/builtin'
import { GRAPH_INPUT, GRAPH_OUTPUT, registerSubgraph } from '../Nodes/subgraph'
import { analyzeGraph } from '../validate'
import { getTslNode, registerTslNode, tslConstant, tslConvert } from './tslNodes'

export interface CompileMaterialOptions {
  /** Textures for Texture nodes, by the name set on the node. Defaults to none: they show magenta */
  textures?(name: string): Texture | undefined
  /** Starting values for the graph's parameters, instead of their defaults */
  parameters?: Record<string, GraphValue>
}

/** A parameter's uniform. Set `.value` to change the material without compiling it again */
export interface ParameterUniform {
  value: number | Vector2 | Vector3 | Vector4 | Color | boolean
}

export interface CompiledMaterial {
  material: MeshStandardNodeMaterial
  /** One per graph parameter, by name */
  parameters: Record<string, ParameterUniform>
}

export class MaterialGraphError extends Error {
  constructor(readonly graph: string, readonly issues: GraphIssue[]) {
    super(`Material graph "${graph}" has problems:\n${issues.map(issue => `  - ${issue.node
      ? `${issue.node}: `
      : ''}${issue.message}`).join('\n')}`)
    this.name = 'MaterialGraphError'
  }
}

function parameterValue(parameter: GraphParameter, value: GraphValue): ParameterUniform['value'] {
  const v = Array.isArray(value)
    ? value
    : [Number(value) || 0]
  switch (parameter.type) {
    case 'vec2':
      return new Vector2(v[0], v[1])
    case 'vec3':
      return new Vector3(v[0], v[1], v[2])
    case 'vec4':
      return new Vector4(v[0], v[1], v[2], v[3])
    case 'color':
      return typeof value === 'string'
        ? new Color(value)
        : new Color(v[0], v[1], v[2])
    case 'bool':
      return !!value
    default:
      return v[0] ?? 0
  }
}

/**
 * Build a PBR material (MeshStandardNodeMaterial) from a material graph: every node's TSL implementation called in
 * order, each input given what its edge brings or its own value, ending in the Material Output node. Throws a
 * `MaterialGraphError` listing what is wrong with the graph.
 */
export function compileMaterialGraph(graph: GraphData, options: CompileMaterialOptions = {}): CompiledMaterial {
  registerBuiltinNodes()
  if (graph.kind !== 'material') {
    throw new MaterialGraphError(graph.name, [
      { message: `It is a ${graph.kind} graph` },
    ])
  }

  const { issues, outputTypes, incoming, order } = analyzeGraph(graph)
  for (const node of graph.nodes) {
    if (getNode(node.type) && !getTslNode(node.type))
      issues.push({ node: node.id, message: `${getNode(node.type)!.label} has no material implementation` })
  }
  const outputs = graph.nodes.filter(node => node.type === 'material.output')
  if (outputs.length !== 1)
    issues.push({ message: `A material graph needs exactly one Material Output node, it has ${outputs.length}` })
  if (issues.length)
    throw new MaterialGraphError(graph.name, issues)

  const material = new MeshStandardNodeMaterial()
  material.name = graph.name

  const parameters: Record<string, ParameterUniform> = {}
  const parameterNodes: Record<string, TslNode> = {}
  for (const parameter of graph.parameters) {
    const node = uniform(parameterValue(parameter, options.parameters?.[parameter.name] ?? parameter.default) as never)
    parameterNodes[parameter.name] = node
    parameters[parameter.name] = node as unknown as ParameterUniform
  }

  buildTslNodes({ outputTypes, incoming, order }, {
    parameter: name => parameterNodes[name],
    texture: name => options.textures?.(name),
    material,
  })

  return { material, parameters }
}

/** What the nodes of a graph being built share: the graph's parameters, the textures, the material */
export type TslBuildContext = Pick<TslNodeContext, 'parameter' | 'texture' | 'material'>

/**
 * Build a graph's nodes as TSL, in order: each input gets what its edge brings (converted to the input's type) or its
 * value. Returns every node's outputs. `override` hands a node's outputs in place of building it (a subgraph's inputs)
 */
export function buildTslNodes(
  analysis: Pick<GraphAnalysis, 'outputTypes' | 'incoming' | 'order'>,
  context: TslBuildContext,
  override?: (node: GraphNodeData) => Record<string, TslNode> | undefined,
): Map<string, Record<string, TslNode>> {
  const { outputTypes, incoming, order } = analysis
  const built = new Map<string, Record<string, TslNode>>()
  for (const node of order) {
    const definition = getNode(node.type)!
    const edges = incoming.get(node.id) ?? {}
    const inputs: Record<string, TslNode> = {}

    for (const [port, spec] of Object.entries(definition.inputs)) {
      const edge = edges[port]
      const arriving: PinType | undefined = edge && outputTypes.get(edge.from.node)?.[edge.from.port]
      if (edge) {
        const source = built.get(edge.from.node)?.[edge.from.port]
        // A fixed type converts what arrives (float into a color); `number` inputs take it as it is
        inputs[port] = spec.type === 'number' || spec.type === 'any' || spec.type === arriving
          ? source
          : tslConvert(source, spec.type)
      }
      else {
        const value = node.values?.[port] ?? spec.default
        const type = spec.type === 'number' || spec.type === 'any'
          ? (Array.isArray(value)
              ? (`vec${value.length}` as PinType)
              : 'float')
          : spec.type
        inputs[port] = tslConstant(value, type)
      }
    }

    built.set(node.id, override?.(node) ?? getTslNode(node.type)!(inputs, {
      ...context,
      values: { ...node.values },
      connected: new Set(Object.keys(edges)),
    }))
    // A Graph Output keeps what it was given, for the subgraph's node to hand on
    if (node.type === GRAPH_OUTPUT)
      built.set(node.id, { value: inputs.value })
  }
  return built
}

/** Subgraphs being inlined, to refuse one that uses itself */
const inlining = new Set<string>()

/**
 * Make the graph `name` usable as a node in material graphs: registered as a subgraph, with a TSL implementation
 * that inlines its nodes. Throws a SubgraphError when it can't be one
 */
export function registerMaterialSubgraph(name: string, graph: GraphData): void {
  registerBuiltinNodes()
  const definition = registerSubgraph(name, graph)
  if (graph.kind !== 'material')
    return
  const analysis = analyzeGraph(graph)
  registerTslNode(definition.type, (inputs, context) => {
    if (inlining.has(name))
      throw new Error(`Subgraph "${name}" uses itself`)
    inlining.add(name)
    try {
      const built = buildTslNodes(analysis, context, node => node.type === GRAPH_INPUT
        ? { value: inputs[String(node.values?.name ?? 'in')] }
        : undefined)
      const outputs: Record<string, TslNode> = {}
      for (const node of graph.nodes) {
        if (node.type === GRAPH_OUTPUT)
          outputs[String(node.values?.name ?? 'out')] = built.get(node.id)?.value
      }
      return outputs
    }
    finally {
      inlining.delete(name)
    }
  })
}
