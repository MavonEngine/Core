import type { SceneObjectData } from '../../src/Scene/types'
import { Object3D } from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { _resetLogicGraphs, LogicGraphObject, registerLogicGraphServerObject, reloadLogicGraph, sendGraphMessage, setGraphSource, watchLogicGraph } from '../../src/Graph/Logic/logicGraphObject'
import { parseGraphData } from '../../src/Graph/types'
import { clearSceneObjects, getSceneObject } from '../../src/Scene/SceneObjectRegistry'

const logger = vi.hoisted(() => ({
  info: vi.fn(),
  warn: vi.fn(),
}))
vi.mock('../../src/BaseGame', () => ({
  default: {
    instance: () => ({ logger }),
  },
}))

/** Turns its Self by 1 radian a second around y, and logs a message it gets */
const spinner = parseGraphData({
  kind: 'logic',
  name: 'spinner',
  nodes: [
    { id: 'tick', type: 'event.tick' },
    {
      id: 'speed',
      type: 'math.multiply',
      values: {
        a: [0, 1, 0],
      },
    },
    { id: 'turn', type: 'entity.addRotation' },
    {
      id: 'on',
      type: 'event.message',
      values: { name: 'ping' },
    },
    {
      id: 'print',
      type: 'action.log',
      values: { value: 'pong' },
    },
  ],
  edges: [
    {
      from: { node: 'tick', port: 'then' },
      to: { node: 'turn', port: 'run' },
    },
    {
      from: { node: 'tick', port: 'delta' },
      to: { node: 'speed', port: 'b' },
    },
    {
      from: { node: 'speed', port: 'result' },
      to: { node: 'turn', port: 'amount' },
    },
    {
      from: { node: 'on', port: 'then' },
      to: { node: 'print', port: 'run' },
    },
  ],
})

function data(props: Record<string, unknown>): SceneObjectData {
  return {
    id: 'logic_1',
    type: 'LogicGraph',
    transform: {
      position: [0, 0, 0],
      rotation: [0, 0, 0],
      scale: [1, 1, 1],
    },
    props,
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('logicGraphObject', () => {
  beforeEach(() => {
    setGraphSource(async name => name === 'spinner'
      ? spinner
      : Promise.reject(new Error('no such graph')))
  })
  afterEach(() => {
    _resetLogicGraphs()
    clearSceneObjects()
    vi.clearAllMocks()
  })

  it('runs its graph on itself, every update', async () => {
    const object = new LogicGraphObject(data({ graph: 'spinner' }), undefined, 'server')
    await flush()

    object.update(0.5)
    object.update(0.5)

    expect(object.rotation.y).toBeCloseTo(1)
  })

  it('acts on the scene object named as its target', async () => {
    const door = new Object3D()
    const scene = {
      get: (id: string) => id === 'door'
        ? {
            data: { type: 'Door' },
            object: { instance: door },
          }
        : undefined,
    }
    const object = new LogicGraphObject(data({ graph: 'spinner', target: 'door' }), scene as any, 'server')
    await flush()

    object.update(2)

    expect(door.rotation.y).toBeCloseTo(2)
    expect(object.rotation.y).toBe(0)
  })

  it('swaps in a new version of its graph, and keeps the old one when the new one is broken', async () => {
    const object = new LogicGraphObject(data({ graph: 'spinner' }), undefined, 'server')
    await flush()
    const still = parseGraphData({
      ...spinner,
      nodes: spinner.nodes.map(node => node.id === 'speed'
        ? {
            ...node,
            values: {
              a: [0, 0, 0],
            },
          }
        : node),
    })

    expect(reloadLogicGraph('spinner', still)).toBe(1)
    object.update(1)
    expect(object.rotation.y).toBe(0)

    const broken = parseGraphData({
      ...spinner,
      nodes: [
        ...spinner.nodes,
        { id: 'x', type: 'nope' },
      ],
    })
    expect(() => reloadLogicGraph('spinner', broken)).toThrow('Unknown node type "nope"')
    expect(reloadLogicGraph('other', spinner)).toBe(0)
  })

  it('tells watchers the steps it runs, and gets messages', async () => {
    const object = new LogicGraphObject(data({ graph: 'spinner' }), undefined, 'server')
    await flush()
    expect(object.runtime).toBeDefined()
    const steps: string[] = []
    const stop = watchLogicGraph('spinner', (node, object) => steps.push(`${object}:${node}`))

    sendGraphMessage('ping')
    stop()
    sendGraphMessage('ping')

    expect(steps).toEqual(['logic_1:on', 'logic_1:print'])
    expect(logger.info).toHaveBeenCalledWith('[spinner] pong')
    expect(logger.info).toHaveBeenCalledTimes(2)
  })

  it('logs why a graph isn\'t running', async () => {
    const object = new LogicGraphObject(data({ graph: 'missing' }), undefined, 'server')
    await flush()

    expect(object.runtime).toBeUndefined()
    expect(object.error).toBe('no such graph')
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining('is not running: no such graph'))
  })

  it('is built on the server only when its side includes the server, and saves its props', async () => {
    registerLogicGraphServerObject()
    const definition = getSceneObject('LogicGraph')!
    const ctx = { scene: undefined as any, side: 'server' as const }

    expect(definition.server!(data({ graph: 'spinner' }), ctx)).toBeUndefined()
    const object = definition.server!(data({ graph: 'spinner', side: 'both' }), ctx) as LogicGraphObject
    expect(object).toBeInstanceOf(LogicGraphObject)
    expect(definition.serialize!(object)).toEqual({ graph: 'spinner', side: 'both' })
    object.destroy()
  })
})
