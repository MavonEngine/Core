import type { NodeDefinition, PortSpec } from '../NodeRegistry'
import type { GraphKind, GraphValue } from '../types'
import { asFloat, asVector, componentWise } from './values'

/*
 * Logic graph nodes: events start a run, exec edges order its steps, actions change the world. Values are pulled
 * from the nodes without exec ports when a step reads them.
 */

const LOGIC: GraphKind[] = ['logic']

const exec: PortSpec = { type: 'exec', label: '' }
const run = { run: exec }
const then = { then: exec }
/** An entity input: a scene object's id, the object running the graph when left empty */
const entity: PortSpec = { type: 'entity', label: 'Entity', default: '' }

function event(type: string, label: string, trigger: string, description: string, extra: Partial<NodeDefinition> = {}): NodeDefinition {
  return {
    type: `event.${type}`,
    label,
    category: 'Events',
    description,
    kinds: LOGIC,
    trigger,
    inputs: {},
    ...extra,
    outputs: {
      ...then,
      ...extra.outputs,
    },
  }
}

/** Reads or writes one of an entity's transforms */
function transformNodes(name: 'position' | 'rotation' | 'scale', label: string): NodeDefinition[] {
  const get = `get${label}` as 'getPosition'
  const set = `set${label}` as 'setPosition'
  return [
    {
      type: `entity.${name}`,
      label,
      category: 'Entity',
      description: `An entity's ${name}`,
      kinds: LOGIC,
      inputs: { entity },
      outputs: {
        [name]: { type: 'vec3' },
      },
      eval: (inputs, context) => ({ [name]: context.entity?.(String(inputs.entity ?? ''))?.[get]() ?? [0, 0, 0] }),
    },
    {
      type: `entity.set${label}`,
      label: `Set ${label}`,
      category: 'Entity',
      kinds: LOGIC,
      inputs: {
        ...run,
        entity,
        [name]: {
          type: 'vec3',
          default: name === 'scale'
            ? [1, 1, 1]
            : [0, 0, 0],
        },
      },
      outputs: then,
      run: (inputs, context) => {
        context.entity?.(String(inputs.entity ?? ''))?.[set](asVector(inputs[name], 3))
      },
    },
    {
      type: `entity.add${label}`,
      label: name === 'position'
        ? 'Move By'
        : name === 'rotation'
          ? 'Rotate By'
          : 'Grow By',
      category: 'Entity',
      description: `Add to an entity's ${name}`,
      kinds: LOGIC,
      inputs: {
        ...run,
        entity,
        amount: {
          type: 'vec3',
          label: 'Amount',
          default: [0, 0, 0],
        },
      },
      outputs: then,
      run: (inputs, context) => {
        const target = context.entity?.(String(inputs.entity ?? ''))
        if (target)
          target[set](componentWise((a, b) => a + b, target[get](), asVector(inputs.amount, 3)) as number[])
      },
    },
  ]
}

const COMPARISONS: Record<string, (a: number, b: number) => boolean> = {
  '<': (a, b) => a < b,
  '<=': (a, b) => a <= b,
  '==': (a, b) => a === b,
  '!=': (a, b) => a !== b,
  '>=': (a, b) => a >= b,
  '>': (a, b) => a > b,
}

function text(value: GraphValue | undefined): string {
  if (Array.isArray(value))
    return `(${value.map(n => Math.round(n * 1000) / 1000).join(', ')})`
  return String(value ?? '')
}

export const LOGIC_NODES: NodeDefinition[] = [
  // ---- Events
  event('start', 'On Start', 'start', 'Once, when the graph starts running'),
  event('tick', 'On Tick', 'tick', 'Every game tick', {
    outputs: {
      delta: { type: 'float', label: 'Delta' },
    },
    run: (_, { event }) => ({
      outputs: {
        delta: asFloat(event.delta),
      },
    }),
  }),
  event('interval', 'Every', 'tick', 'Every few seconds', {
    settings: {
      seconds: { type: 'float', default: 1 },
    },
    run: (_, { event, values, state }) => {
      const seconds = Math.max(asFloat(values.seconds ?? 1), 0.001)
      state.elapsed = (state.elapsed as number ?? 0) + asFloat(event.delta)
      if ((state.elapsed as number) < seconds)
        return false
      state.elapsed = (state.elapsed as number) - seconds
    },
  }),
  event('key', 'On Key', 'keydown', 'When a key is pressed, by its code (Space, KeyW, ArrowUp...). Client only', {
    settings: {
      key: { type: 'string', default: 'Space' },
    },
    run: (_, { event, values }) => event.code === values.key
      ? undefined
      : false,
  }),
  event('message', 'On Message', 'message', 'When a graph sends a message with this name', {
    settings: {
      name: { type: 'string', default: '' },
    },
    outputs: {
      value: { type: 'any', label: 'Value' },
    },
    run: (_, { event, values }) => event.name === values.name
      ? {
          outputs: { value: event.value ?? 0 },
        }
      : false,
  }),

  // ---- Flow
  {
    type: 'flow.branch',
    label: 'Branch',
    category: 'Flow',
    description: 'Continues from True or False',
    kinds: LOGIC,
    inputs: {
      ...run,
      condition: { type: 'bool', default: false },
    },
    outputs: {
      true: { type: 'exec', label: 'True' },
      false: { type: 'exec', label: 'False' },
    },
    run: ({ condition }) => ({
      next: condition ? 'true' : 'false',
    }),
  },
  {
    type: 'flow.sequence',
    label: 'Sequence',
    category: 'Flow',
    description: 'Continues from each output in turn',
    kinds: LOGIC,
    inputs: run,
    outputs: {
      first: { type: 'exec', label: '1' },
      second: { type: 'exec', label: '2' },
      third: { type: 'exec', label: '3' },
    },
    run: () => ({
      next: ['first', 'second', 'third'],
    }),
  },
  {
    type: 'flow.once',
    label: 'Do Once',
    category: 'Flow',
    description: 'Continues the first time only',
    kinds: LOGIC,
    inputs: run,
    outputs: then,
    run: (_, { state }) => {
      if (state.done)
        return { next: [] }
      state.done = true
    },
  },
  {
    type: 'flow.delay',
    label: 'Delay',
    category: 'Flow',
    description: 'Continues after some seconds',
    kinds: LOGIC,
    inputs: {
      ...run,
      seconds: { type: 'float', default: 1 },
    },
    outputs: then,
    run: ({ seconds }, { after }) => {
      after(asFloat(seconds), 'then')
      return { next: [] }
    },
  },

  // ---- Actions
  {
    type: 'action.log',
    label: 'Log',
    category: 'Actions',
    description: 'Write a value to the game\'s log',
    kinds: LOGIC,
    inputs: {
      ...run,
      value: { type: 'any', default: 'Hello' },
    },
    outputs: then,
    run: ({ value }, { log }) => {
      log(text(value))
    },
  },
  {
    type: 'action.send',
    label: 'Send Message',
    category: 'Actions',
    description: 'To every logic graph on this side: their On Message nodes with the same name run',
    kinds: LOGIC,
    inputs: {
      ...run,
      value: { type: 'any', default: 0 },
    },
    outputs: then,
    settings: {
      name: { type: 'string', default: '' },
    },
    run: ({ value }, { emit, values }) => {
      emit(String(values.name ?? ''), value ?? 0)
    },
  },

  // ---- Variables
  {
    type: 'variable.get',
    label: 'Get Variable',
    category: 'Variables',
    description: 'A value the graph keeps. Starts as the parameter of the same name, if any',
    kinds: LOGIC,
    inputs: {},
    outputs: {
      value: { type: 'any' },
    },
    settings: {
      name: { type: 'string', default: '' },
    },
    resolveOutputs: ({ values, graph }) => {
      const parameter = graph.parameters.find(p => p.name === values.name)
      return parameter
        ? { value: parameter.type }
        : {}
    },
    eval: (_, { values, variables, parameters }) => {
      const name = String(values.name ?? '')
      return { value: variables?.get(name) ?? parameters[name] ?? 0 }
    },
  },
  {
    type: 'variable.set',
    label: 'Set Variable',
    category: 'Variables',
    kinds: LOGIC,
    inputs: {
      ...run,
      value: { type: 'any', default: 0 },
    },
    outputs: then,
    settings: {
      name: { type: 'string', default: '' },
    },
    run: ({ value }, { values, variables }) => {
      variables?.set(String(values.name ?? ''), value ?? 0)
    },
  },

  // ---- Entities
  {
    type: 'entity.self',
    label: 'Self',
    category: 'Entity',
    description: 'The object running the graph',
    kinds: LOGIC,
    inputs: {},
    outputs: {
      entity: { type: 'entity' },
    },
    eval: (_, { self }) => ({ entity: self?.id ?? '' }),
  },
  {
    type: 'entity.byId',
    label: 'Scene Object',
    category: 'Entity',
    description: 'A scene object by its id',
    kinds: LOGIC,
    inputs: {},
    outputs: {
      entity: { type: 'entity' },
    },
    settings: {
      id: { type: 'string', default: '' },
    },
    eval: (_, { values }) => ({
      entity: String(values.id ?? ''),
    }),
  },
  ...transformNodes('position', 'Position'),
  ...transformNodes('rotation', 'Rotation'),
  ...transformNodes('scale', 'Scale'),

  // ---- Logic
  {
    type: 'logic.compare',
    label: 'Compare',
    category: 'Logic',
    kinds: LOGIC,
    inputs: {
      a: { type: 'float', default: 0 },
      b: { type: 'float', default: 0 },
    },
    outputs: {
      result: { type: 'bool' },
    },
    settings: {
      op: { type: 'string', default: '<' },
    },
    eval: ({ a, b }, { values }) => ({
      result: (COMPARISONS[String(values.op)] ?? COMPARISONS['<']!)(asFloat(a), asFloat(b)),
    }),
  },
  {
    type: 'logic.and',
    label: 'And',
    category: 'Logic',
    kinds: LOGIC,
    inputs: {
      a: { type: 'bool', default: false },
      b: { type: 'bool', default: false },
    },
    outputs: {
      result: { type: 'bool' },
    },
    eval: ({ a, b }) => ({ result: !!a && !!b }),
  },
  {
    type: 'logic.or',
    label: 'Or',
    category: 'Logic',
    kinds: LOGIC,
    inputs: {
      a: { type: 'bool', default: false },
      b: { type: 'bool', default: false },
    },
    outputs: {
      result: { type: 'bool' },
    },
    eval: ({ a, b }) => ({ result: !!a || !!b }),
  },
  {
    type: 'logic.not',
    label: 'Not',
    category: 'Logic',
    kinds: LOGIC,
    inputs: {
      value: { type: 'bool', default: false },
    },
    outputs: {
      result: { type: 'bool' },
    },
    eval: ({ value }) => ({ result: !value }),
  },
  {
    type: 'input.bool',
    label: 'Bool',
    category: 'Input',
    kinds: LOGIC,
    inputs: {},
    outputs: {
      value: { type: 'bool' },
    },
    settings: {
      value: { type: 'bool', default: false },
    },
    eval: (_, { values }) => ({ value: !!values.value }),
  },
  {
    type: 'input.string',
    label: 'Text',
    category: 'Input',
    kinds: LOGIC,
    inputs: {},
    outputs: {
      value: { type: 'string' },
    },
    settings: {
      value: { type: 'string', default: '' },
    },
    eval: (_, { values }) => ({
      value: String(values.value ?? ''),
    }),
  },
]
