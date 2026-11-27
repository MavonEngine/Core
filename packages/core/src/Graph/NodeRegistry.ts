import type { GraphData, GraphKind, GraphValue, PinType, PortType } from './types'

export interface PortSpec {
  type: PortType
  /** Shown on the node. Defaults to the port name */
  label?: string
  /** An input's value while nothing is connected to it */
  default?: GraphValue
}

/** What `resolveOutputs` gets */
export interface NodeTypeContext {
  /** The types arriving at the inputs, from edges or the inputs' values */
  inputs: Record<string, PinType>
  values: Record<string, GraphValue>
  graph: GraphData
}

/** What an `eval` implementation gets besides its inputs */
export interface NodeEvalContext {
  /** The graph's parameter values by name */
  parameters: Record<string, GraphValue>
  /** The node's own settings and unconnected input values */
  values: Record<string, GraphValue>
  /** Seconds since the graph started running */
  time: number
}

/**
 * A type of node. Its implementations come separately: `eval` here for logic graphs, the TSL one through
 * `registerTslNode()` (Graph/Material), so the server never loads three's node system.
 */
export interface NodeDefinition {
  /** Unique key, e.g. `math.add` */
  type: string
  label: string
  /** Groups the editor's node list, e.g. `Math` */
  category: string
  description?: string
  /** The graphs it can be used in */
  kinds: GraphKind[]
  inputs: Record<string, PortSpec>
  outputs: Record<string, PortSpec>
  /** Values set on the node itself rather than connected, e.g. a constant's value */
  settings?: Record<string, PortSpec>
  /** Only the WebGPU backend runs it, the editor warns about it on WebGL 2 */
  requires?: 'webgpu'
  /** npm package of the plugin that registered it */
  plugin?: string
  /**
   * Output types that depend on more than the inputs' types, e.g. a parameter node's on the parameter it reads.
   * Returns some or all outputs; the rest follow the usual rules
   */
  resolveOutputs?(context: NodeTypeContext): Partial<Record<string, PinType>>
  /** Its outputs from its inputs, for logic graphs */
  eval?(inputs: Record<string, GraphValue>, context: NodeEvalContext): Record<string, GraphValue>
}

const registry = new Map<string, NodeDefinition>()

/** Make a node type usable in graphs. Registering a type again replaces it */
export function registerNode(definition: NodeDefinition): void {
  registry.set(definition.type, definition)
}

export function unregisterNode(type: string): void {
  registry.delete(type)
}

export function getNode(type: string): NodeDefinition | undefined {
  return registry.get(type)
}

/** The registered node types, optionally only those usable in `kind` graphs */
export function getNodes(kind?: GraphKind): NodeDefinition[] {
  const all = [
    ...registry.values(),
  ]
  return kind
    ? all.filter(node => node.kinds.includes(kind))
    : all
}

/** For tests */
export function clearNodes(): void {
  registry.clear()
}

const COMPONENTS: Partial<Record<PinType, number>> = {
  float: 1,
  int: 1,
  vec2: 2,
  vec3: 3,
  color: 3,
  vec4: 4,
}

/** How many numbers a value of `type` holds, undefined for what isn't a number or vector */
export function componentCount(type: PinType): number | undefined {
  return COMPONENTS[type]
}

/** Whether a value of `from` can go into an input of `to`. Numbers widen (float into vec3), color and vec3 mix */
export function canConnect(from: PinType, to: PortType): boolean {
  if (from === to)
    return true
  const fromCount = componentCount(from)
  if (fromCount === undefined)
    return false
  if (to === 'number')
    return true
  const toCount = componentCount(to)
  if (toCount === undefined)
    return false
  // A single number fills every component; otherwise same size (vec3 and color), or into a float as its first
  return fromCount === 1 || fromCount === toCount || toCount === 1
}

/** The type a `number` output takes: the widest of the types its `number` inputs got, float with none */
export function widestType(types: PinType[]): PinType {
  const count = Math.max(1, ...types.map(type => componentCount(type) ?? 0))
  if (count === 1)
    return 'float'
  if (count === 2)
    return 'vec2'
  if (count === 4)
    return 'vec4'
  // Colors stay colors, mixed with a vec3 they read as one
  return types.every(type => componentCount(type) !== 3 || type === 'color')
    ? 'color'
    : 'vec3'
}
