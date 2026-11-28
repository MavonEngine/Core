import type { GraphEntity, NodeDefinition, NodeEvalContext, NodeRunContext } from '../NodeRegistry'
import type { GraphData, GraphNodeData, GraphValue } from '../types'
import type { GraphAnalysis, GraphIssue } from '../validate'
import { getNode, isStep } from '../NodeRegistry'
import { registerBuiltinNodes } from '../Nodes/builtin'
import { analyzeGraph } from '../validate'

export interface GraphRuntimeOptions {
  /** The object running the graph */
  self?: GraphEntity
  /** Another scene object by id, for entity inputs */
  find?(id: string): GraphEntity | undefined
  /** Values for the graph's parameters, instead of their defaults */
  parameters?: Record<string, GraphValue>
  /** Where Log nodes write */
  log?(message: string): void
  /** Where Send Message nodes send, to every graph on this side. Without it a graph only messages itself */
  emit?(name: string, value: GraphValue): void
  /** Told each step as it runs, for debugging */
  onStep?(node: string): void
  /** The most steps one event may run, so a loop in the exec edges can't hang the game. Default 10 000 */
  maxSteps?: number
}

export class GraphRuntimeError extends Error {
  constructor(readonly graph: string, readonly issues: GraphIssue[]) {
    super(`Logic graph "${graph}" has problems:\n${issues.map(issue => `  - ${issue.node
      ? `${issue.node}: `
      : ''}${issue.message}`).join('\n')}`)
    this.name = 'GraphRuntimeError'
  }
}

interface Timer {
  at: number
  node: string
  port: string
}

/**
 * Runs a logic graph. Events (`start()`, `update()`, `trigger()`) run the event nodes listening for them, which
 * continue along their exec edges step by step. A step reads its inputs from the nodes feeding them: nodes without
 * exec ports are worked out when read (once per event), steps hand on the outputs they last produced.
 */
export class GraphRuntime {
  readonly graph: GraphData
  readonly analysis: GraphAnalysis
  /** Seconds since `start()` */
  time = 0
  /** The graph's variables (Set Variable / Get Variable) */
  readonly variables = new Map<string, GraphValue>()

  private readonly nodes: Map<string, GraphNodeData>
  private readonly definitions = new Map<string, NodeDefinition>()
  private readonly parameters: Record<string, GraphValue>
  /** What each step last output */
  private readonly latched = new Map<string, Record<string, GraphValue>>()
  private readonly states = new Map<string, Record<string, unknown>>()
  private timers: Timer[] = []
  private started = false

  constructor(graph: GraphData, private readonly options: GraphRuntimeOptions = {}) {
    registerBuiltinNodes()
    if (graph.kind !== 'logic') {
      throw new GraphRuntimeError(graph.name, [
        { message: `It is a ${graph.kind} graph` },
      ])
    }

    this.graph = graph
    this.analysis = analyzeGraph(graph)
    const issues = [...this.analysis.issues]
    for (const node of graph.nodes) {
      const definition = getNode(node.type)
      if (!definition)
        continue
      this.definitions.set(node.id, definition)
      if (isStep(definition)
        ? !definition.run && !definition.trigger
        : !definition.eval) {
        issues.push({ node: node.id, message: `${definition.label} can't run in a logic graph` })
      }
    }
    if (issues.length)
      throw new GraphRuntimeError(graph.name, issues)

    this.nodes = new Map(graph.nodes.map(node => [node.id, node]))
    this.parameters = Object.fromEntries(graph.parameters.map(p => [p.name, options.parameters?.[p.name] ?? p.default]))
  }

  /** Run the On Start nodes. Once */
  start() {
    if (this.started)
      return
    this.started = true
    this.trigger('start')
  }

  /** Move time on: run what Delay nodes put off, then the On Tick nodes */
  update(delta: number) {
    if (!this.started)
      this.start()
    this.time += delta

    const due = this.timers.filter(timer => timer.at <= this.time)
    if (due.length) {
      this.timers = this.timers.filter(timer => timer.at > this.time)
      for (const timer of due)
        this.runFrom(timer.node, timer.port)
    }

    this.trigger('tick', { delta })
  }

  /** Run the event nodes listening for `event` (`keydown`, `message`, or a plugin's own) */
  trigger(event: string, payload: Record<string, GraphValue> = {}) {
    for (const [id, definition] of this.definitions) {
      if (definition.trigger !== event)
        continue
      const result = definition.run?.({}, this.runContext(id, payload))
      if (result === false)
        continue
      this.options.onStep?.(id)
      this.finishStep(id, result || undefined)
    }
  }

  /** Message every graph would get from a Send Message node */
  message(name: string, value: GraphValue) {
    this.trigger('message', { name, value })
  }

  private evalContext(id: string): NodeEvalContext {
    const self = this.options.self
    return {
      parameters: this.parameters,
      values: this.nodes.get(id)?.values ?? {},
      time: this.time,
      self,
      entity: target => target
        ? this.options.find?.(target)
        : self,
      variables: this.variables,
    }
  }

  private runContext(id: string, event: Record<string, GraphValue>): NodeRunContext {
    let state = this.states.get(id)
    if (!state) {
      state = {}
      this.states.set(id, state)
    }
    return {
      ...this.evalContext(id),
      event,
      state,
      after: (seconds, port) => this.timers.push({ at: this.time + Math.max(0, seconds), node: id, port }),
      emit: (name, value) => this.options.emit
        ? this.options.emit(name, value)
        : this.message(name, value),
      log: message => this.options.log?.(message),
    }
  }

  /** An output's value: a step's last output, or a value node worked out now (cached for this event) */
  private value(id: string, port: string, cache: Map<string, Record<string, GraphValue>>): GraphValue | undefined {
    const definition = this.definitions.get(id)!
    if (isStep(definition))
      return this.latched.get(id)?.[port]

    let outputs = cache.get(id)
    if (!outputs) {
      outputs = definition.eval!(this.inputs(id, cache), this.evalContext(id))
      cache.set(id, outputs)
    }
    return outputs[port]
  }

  private inputs(id: string, cache: Map<string, Record<string, GraphValue>>): Record<string, GraphValue> {
    const definition = this.definitions.get(id)!
    const node = this.nodes.get(id)!
    const edges = this.analysis.incoming.get(id) ?? {}
    const inputs: Record<string, GraphValue> = {}
    for (const [port, spec] of Object.entries(definition.inputs)) {
      if (spec.type === 'exec')
        continue
      const edge = edges[port]
      const value = edge
        ? this.value(edge.from.node, edge.from.port, cache)
        : node.values?.[port] ?? spec.default
      if (value !== undefined)
        inputs[port] = value
    }
    return inputs
  }

  /** Continue from a step's exec output `port` */
  private runFrom(id: string, port: string) {
    const target = this.analysis.execOut.get(id)?.[port]
    if (target)
      this.runSteps([target.node])
  }

  /** Keep a step's outputs and continue from the exec outputs it chose */
  private finishStep(id: string, result: { next?: string | string[], outputs?: Record<string, GraphValue> } | undefined) {
    if (result?.outputs) {
      this.latched.set(id, {
        ...this.latched.get(id),
        ...result.outputs,
      })
    }
    const next = this.nextPorts(id, result?.next)
    const targets = next.map(port => this.analysis.execOut.get(id)?.[port]?.node).filter((node): node is string => !!node)
    this.runSteps(targets)
  }

  private nextPorts(id: string, next: string | string[] | undefined): string[] {
    if (next !== undefined) {
      return Array.isArray(next)
        ? next
        : [next]
    }
    const first = Object.entries(this.definitions.get(id)!.outputs).find(([, spec]) => spec.type === 'exec')
    return first
      ? [first[0]]
      : []
  }

  /** Run steps depth first, in the order their exec outputs list them */
  private runSteps(start: string[]) {
    const max = this.options.maxSteps ?? 10_000
    const stack = [...start].reverse()
    let steps = 0
    while (stack.length) {
      if (++steps > max) {
        this.options.log?.(`Logic graph "${this.graph.name}" stopped after ${max} steps: do its exec edges loop?`)
        return
      }
      const id = stack.pop()!
      this.options.onStep?.(id)
      const definition = this.definitions.get(id)!
      // Values are read fresh for every step, so a step sees what earlier ones changed
      const result = definition.run?.(this.inputs(id, new Map()), this.runContext(id, {})) || undefined
      if (result?.outputs) {
        this.latched.set(id, {
          ...this.latched.get(id),
          ...result.outputs,
        })
      }
      const targets = this.nextPorts(id, result?.next)
        .map(port => this.analysis.execOut.get(id)?.[port]?.node)
        .filter((node): node is string => !!node)
      stack.push(...targets.reverse())
    }
  }
}
