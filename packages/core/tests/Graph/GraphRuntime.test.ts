import type { GraphEntity } from '../../src/Graph/NodeRegistry'
import type { GraphEdgeData, GraphNodeData, GraphParameter } from '../../src/Graph/types'
import { describe, expect, it, vi } from 'vitest'
import { GraphRuntime, GraphRuntimeError } from '../../src/Graph/Logic/GraphRuntime'
import { parseGraphData } from '../../src/Graph/types'

type Node = Omit<GraphNodeData, 'position'>

function logic(nodes: Node[], edges: [string, string][] = [], parameters: GraphParameter[] = []) {
  return parseGraphData({
    kind: 'logic',
    name: 'test',
    nodes,
    parameters,
    // 'node.port' pairs
    edges: edges.map(([from, to]): GraphEdgeData => {
      const [fromNode, fromPort] = from.split('.') as [string, string]
      const [toNode, toPort] = to.split('.') as [string, string]
      return {
        from: { node: fromNode, port: fromPort },
        to: { node: toNode, port: toPort },
      }
    }),
  })
}

function entity(id: string, position = [0, 0, 0]): GraphEntity & { position: number[] } {
  const e = {
    id,
    position,
    rotation: [0, 0, 0],
    scale: [1, 1, 1],
    getPosition: () => [...e.position],
    setPosition: (v: number[]) => { e.position = v },
    getRotation: () => [...e.rotation],
    setRotation: (v: number[]) => { e.rotation = v },
    getScale: () => [...e.scale],
    setScale: (v: number[]) => { e.scale = v },
  }
  return e
}

describe('graphRuntime', () => {
  it('runs On Start once, following its exec edges', () => {
    const log = vi.fn()
    const runtime = new GraphRuntime(logic([
      { id: 'start', type: 'event.start' },
      {
        id: 'hello',
        type: 'action.log',
        values: { value: 'hello' },
      },
      {
        id: 'world',
        type: 'action.log',
        values: { value: 'world' },
      },
    ], [
      ['start.then', 'hello.run'],
      ['hello.then', 'world.run'],
    ]), { log })

    runtime.start()
    runtime.start()
    runtime.update(0.1)

    expect(log.mock.calls).toEqual([
      ['hello'],
      ['world'],
    ])
  })

  it('reads values from the nodes feeding a step, fresh for every step', () => {
    const self = entity('player', [1, 2, 3])
    const runtime = new GraphRuntime(logic([
      { id: 'tick', type: 'event.tick' },
      {
        id: 'speed',
        type: 'input.vec3',
        values: {
          value: [0, 0, 2],
        },
      },
      { id: 'step', type: 'math.multiply' },
      { id: 'move', type: 'entity.addPosition' },
    ], [
      ['tick.then', 'move.run'],
      ['speed.value', 'step.a'],
      ['tick.delta', 'step.b'],
      ['step.result', 'move.amount'],
    ]), { self })

    runtime.update(0.5)
    runtime.update(0.5)

    expect(self.position).toEqual([1, 2, 5])
  })

  it('branches, keeps variables and starts them from parameters', () => {
    const log = vi.fn()
    // Counts ticks, logs "done" once the count reaches the limit
    const runtime = new GraphRuntime(logic([
      { id: 'tick', type: 'event.tick' },
      {
        id: 'count',
        type: 'variable.get',
        values: { name: 'count' },
      },
      {
        id: 'plus',
        type: 'math.add',
        values: { b: 1 },
      },
      {
        id: 'store',
        type: 'variable.set',
        values: { name: 'count' },
      },
      {
        id: 'limit',
        type: 'input.parameter',
        values: { name: 'limit' },
      },
      {
        id: 'reached',
        type: 'logic.compare',
        values: { op: '>=' },
      },
      { id: 'branch', type: 'flow.branch' },
      {
        id: 'done',
        type: 'action.log',
        values: { value: 'done' },
      },
    ], [
      ['tick.then', 'store.run'],
      ['count.value', 'plus.a'],
      ['plus.result', 'store.value'],
      ['store.then', 'branch.run'],
      ['count.value', 'reached.a'],
      ['limit.value', 'reached.b'],
      ['reached.result', 'branch.condition'],
      ['branch.true', 'done.run'],
    ], [
      { name: 'count', type: 'float', default: 10 },
      { name: 'limit', type: 'float', default: 12 },
    ]), { log })

    runtime.update(0.1)
    expect(runtime.variables.get('count')).toBe(11)
    expect(log).not.toHaveBeenCalled()
    runtime.update(0.1)
    expect(log).toHaveBeenCalledWith('done')
  })

  it('runs a sequence in order, depth first, and Do Once only once', () => {
    const log = vi.fn()
    const runtime = new GraphRuntime(logic([
      { id: 'tick', type: 'event.tick' },
      { id: 'seq', type: 'flow.sequence' },
      { id: 'once', type: 'flow.once' },
      {
        id: 'a',
        type: 'action.log',
        values: { value: 'a' },
      },
      {
        id: 'b',
        type: 'action.log',
        values: { value: 'b' },
      },
      {
        id: 'c',
        type: 'action.log',
        values: { value: 'c' },
      },
    ], [
      ['tick.then', 'seq.run'],
      ['seq.first', 'once.run'],
      ['once.then', 'a.run'],
      ['a.then', 'b.run'],
      ['seq.second', 'c.run'],
    ]), { log })

    runtime.update(0.1)
    runtime.update(0.1)

    expect(log.mock.calls.flat()).toEqual(['a', 'b', 'c', 'c'])
  })

  it('delays, and runs Every on its interval', () => {
    const log = vi.fn()
    const runtime = new GraphRuntime(logic([
      { id: 'start', type: 'event.start' },
      {
        id: 'wait',
        type: 'flow.delay',
        values: { seconds: 1 },
      },
      {
        id: 'late',
        type: 'action.log',
        values: { value: 'late' },
      },
      {
        id: 'every',
        type: 'event.interval',
        values: { seconds: 0.5 },
      },
      {
        id: 'beat',
        type: 'action.log',
        values: { value: 'beat' },
      },
    ], [
      ['start.then', 'wait.run'],
      ['wait.then', 'late.run'],
      ['every.then', 'beat.run'],
    ]), { log })

    for (let i = 0; i < 10; i++)
      runtime.update(0.25)

    expect(log.mock.calls.flat().filter(m => m === 'beat')).toHaveLength(5)
    // At 1s, after the beat at 0.5s and before the one at 1s
    expect(log.mock.calls.flat().indexOf('late')).toBe(1)
  })

  it('acts on other scene objects by id', () => {
    const door = entity('door')
    const runtime = new GraphRuntime(logic([
      { id: 'start', type: 'event.start' },
      {
        id: 'door',
        type: 'entity.byId',
        values: { id: 'door' },
      },
      {
        id: 'open',
        type: 'entity.setRotation',
        values: {
          rotation: [0, 1.5, 0],
        },
      },
    ], [
      ['start.then', 'open.run'],
      ['door.entity', 'open.entity'],
    ]), {
      self: entity('lever'),
      find: id => id === 'door'
        ? door
        : undefined,
    })

    runtime.start()

    expect(door.rotation).toEqual([0, 1.5, 0])
  })

  it('passes messages between On Message and Send Message, and filters keys', () => {
    const log = vi.fn()
    const runtime = new GraphRuntime(logic([
      {
        id: 'key',
        type: 'event.key',
        values: { key: 'Space' },
      },
      {
        id: 'send',
        type: 'action.send',
        values: { name: 'jump', value: 3 },
      },
      {
        id: 'on',
        type: 'event.message',
        values: { name: 'jump' },
      },
      { id: 'print', type: 'action.log' },
    ], [
      ['key.then', 'send.run'],
      ['on.then', 'print.run'],
      ['on.value', 'print.value'],
    ]), { log })

    runtime.trigger('keydown', { code: 'KeyW' })
    expect(log).not.toHaveBeenCalled()
    runtime.trigger('keydown', { code: 'Space' })
    expect(log).toHaveBeenCalledWith('3')
  })

  it('lets a run through a Cooldown at most once every few seconds', () => {
    const log = vi.fn()
    const runtime = new GraphRuntime(logic([
      {
        id: 'on',
        type: 'event.message',
        values: { name: 'poke' },
      },
      {
        id: 'wait',
        type: 'flow.cooldown',
        values: { seconds: 10 },
      },
      {
        id: 'yes',
        type: 'action.log',
        values: { value: 'answered' },
      },
      {
        id: 'no',
        type: 'action.log',
        values: { value: 'too soon' },
      },
    ], [
      ['on.then', 'wait.run'],
      ['wait.then', 'yes.run'],
      ['wait.blocked', 'no.run'],
    ]), { log })
    runtime.start()

    runtime.message('poke', 0)
    runtime.update(4)
    runtime.message('poke', 0)
    runtime.update(6)
    runtime.message('poke', 0)

    expect(log.mock.calls.flat()).toEqual(['answered', 'too soon', 'answered'])
  })

  it('skips comments', () => {
    const log = vi.fn()
    const runtime = new GraphRuntime(logic([
      {
        id: 'note',
        type: 'graph.comment',
        values: { text: 'Says hello once' },
      },
      { id: 'start', type: 'event.start' },
      {
        id: 'hello',
        type: 'action.log',
        values: { value: 'hello' },
      },
    ], [
      ['start.then', 'hello.run'],
    ]), { log })

    runtime.start()

    expect(log).toHaveBeenCalledWith('hello')
  })

  it('stops a run that loops forever', () => {
    const log = vi.fn()
    const runtime = new GraphRuntime(logic([
      { id: 'start', type: 'event.start' },
      { id: 'a', type: 'flow.sequence' },
    ], [
      ['start.then', 'a.run'],
      ['a.first', 'a.run'],
    ]), { log, maxSteps: 50 })

    runtime.start()

    expect(log).toHaveBeenCalledWith(expect.stringContaining('stopped after 50 steps'))
  })

  it('refuses graphs with problems or of the wrong kind', () => {
    expect(() => new GraphRuntime(logic([
      { id: 'x', type: 'surface.uv' },
    ]))).toThrow(GraphRuntimeError)
    expect(() => new GraphRuntime(logic([
      { id: 'start', type: 'event.start' },
      { id: 'a', type: 'action.log' },
      { id: 'b', type: 'action.log' },
    ], [
      ['start.then', 'a.run'],
      ['start.then', 'b.run'],
    ]))).toThrow('exec output "then" has more than one edge')
    expect(() => new GraphRuntime(parseGraphData({ kind: 'material' }))).toThrow('It is a material graph')
  })
})
