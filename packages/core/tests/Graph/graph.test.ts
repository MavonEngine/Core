import type { GraphData } from '../../src/Graph/types'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { graphFilePath, readGraphFile, writeGraphFile } from '../../src/Graph/loadGraphFile'
import { canConnect, clearNodes, getNode, getNodes, widestType } from '../../src/Graph/NodeRegistry'
import { registerBuiltinNodes } from '../../src/Graph/Nodes/builtin'
import { parseGraphData } from '../../src/Graph/types'
import { analyzeGraph } from '../../src/Graph/validate'

function graph(partial: Partial<GraphData>): GraphData {
  return parseGraphData({ kind: 'material', name: 'test', ...partial })
}

describe('parseGraphData', () => {
  it('fills in what may be left out', () => {
    expect(parseGraphData({
      kind: 'logic',
      nodes: [
        { id: 'a', type: 'input.time' },
      ],
    }, 'fallback')).toEqual({
      version: 1,
      kind: 'logic',
      name: 'fallback',
      nodes: [
        {
          id: 'a',
          type: 'input.time',
          position: [0, 0],
        },
      ],
      edges: [],
      parameters: [],
    })
  })

  it('keeps which group a node is in', () => {
    const graph = parseGraphData({
      kind: 'logic',
      nodes: [
        {
          id: 'box',
          type: 'graph.group',
          values: { name: 'Walk' },
        },
        { id: 'tick', type: 'event.tick', group: 'box' },
        { id: 'loose', type: 'event.start', group: 3 },
      ],
    })
    expect(graph.nodes.map(node => node.group)).toEqual([undefined, 'box', undefined])
  })

  it('says what is wrong with a malformed graph', () => {
    expect(() => parseGraphData(null)).toThrow('JSON object')
    expect(() => parseGraphData({ kind: 'shader' })).toThrow('"kind" must be one of material, logic')
    expect(() => parseGraphData({ kind: 'material', version: 99 })).toThrow('newer than this engine')
    expect(() => parseGraphData({
      kind: 'material',
      nodes: [
        { id: 'a' },
      ],
    })).toThrow('node 0 needs a "type"')
    expect(() => parseGraphData({
      kind: 'material',
      nodes: [
        { id: 'a', type: 'x' },
        { id: 'a', type: 'y' },
      ],
    })).toThrow('"a" is used twice')
    expect(() => parseGraphData({
      kind: 'material',
      edges: [
        {
          from: { node: 'a' },
        },
      ],
    })).toThrow('edge 0 "from" needs a "node" and a "port"')
  })
})

describe('pin types', () => {
  it('lets numbers widen and colors stand in for vec3', () => {
    expect(canConnect('float', 'vec3')).toBe(true)
    expect(canConnect('color', 'vec3')).toBe(true)
    expect(canConnect('vec3', 'float')).toBe(true)
    expect(canConnect('vec2', 'vec3')).toBe(false)
    expect(canConnect('vec4', 'number')).toBe(true)
    expect(canConnect('texture', 'number')).toBe(false)
    expect(canConnect('exec', 'exec')).toBe(true)
    expect(canConnect('float', 'exec')).toBe(false)
  })

  it('gives number outputs the widest input type', () => {
    expect(widestType([])).toBe('float')
    expect(widestType(['float', 'vec3'])).toBe('vec3')
    expect(widestType(['color', 'float'])).toBe('color')
    expect(widestType(['color', 'vec3'])).toBe('vec3')
    expect(widestType(['vec2', 'vec4'])).toBe('vec4')
  })
})

describe('analyzeGraph', () => {
  beforeAll(() => registerBuiltinNodes())
  afterAll(() => clearNodes())

  it('orders the nodes after what feeds them and works out their types', () => {
    const { issues, order, outputTypes } = analyzeGraph(graph({
      nodes: [
        {
          id: 'out',
          type: 'material.output',
          position: [0, 0],
        },
        {
          id: 'mul',
          type: 'math.multiply',
          position: [0, 0],
        },
        {
          id: 'tint',
          type: 'input.color',
          position: [0, 0],
          values: {
            value: [1, 0, 0],
          },
        },
        {
          id: 'time',
          type: 'input.time',
          position: [0, 0],
        },
      ],
      edges: [
        {
          from: { node: 'tint', port: 'value' },
          to: { node: 'mul', port: 'a' },
        },
        {
          from: { node: 'time', port: 'seconds' },
          to: { node: 'mul', port: 'b' },
        },
        {
          from: { node: 'mul', port: 'result' },
          to: { node: 'out', port: 'color' },
        },
      ],
    }))

    expect(issues).toEqual([])
    const ids = order.map(node => node.id)
    expect(ids.indexOf('mul')).toBeGreaterThan(ids.indexOf('tint'))
    expect(ids.indexOf('out')).toBeGreaterThan(ids.indexOf('mul'))
    expect(outputTypes.get('mul')).toEqual({ result: 'color' })
  })

  it('types a parameter node by the parameter it reads', () => {
    const { outputTypes } = analyzeGraph(graph({
      parameters: [
        {
          name: 'tint',
          type: 'color',
          default: [1, 1, 1],
        },
      ],
      nodes: [
        {
          id: 'p',
          type: 'input.parameter',
          position: [0, 0],
          values: { name: 'tint' },
        },
      ],
    }))
    expect(outputTypes.get('p')).toEqual({ value: 'color' })
  })

  it('reports unknown nodes and ports, the wrong kind, doubled inputs, bad types and loops', () => {
    const { issues } = analyzeGraph(graph({
      kind: 'logic',
      nodes: [
        {
          id: 'a',
          type: 'math.add',
          position: [0, 0],
        },
        {
          id: 'b',
          type: 'math.add',
          position: [0, 0],
        },
        {
          id: 'uv',
          type: 'surface.uv',
          position: [0, 0],
        },
        {
          id: 'cross',
          type: 'vector.cross',
          position: [0, 0],
        },
        {
          id: 'what',
          type: 'nope',
          position: [0, 0],
        },
      ],
      edges: [
        {
          from: { node: 'a', port: 'result' },
          to: { node: 'b', port: 'a' },
        },
        {
          from: { node: 'b', port: 'result' },
          to: { node: 'a', port: 'a' },
        },
        {
          from: { node: 'uv', port: 'value' },
          to: { node: 'cross', port: 'a' },
        },
        {
          from: { node: 'uv', port: 'value' },
          to: { node: 'cross', port: 'a' },
        },
        {
          from: { node: 'uv', port: 'nothing' },
          to: { node: 'cross', port: 'b' },
        },
      ],
    }))

    const messages = issues.map(issue => issue.message)
    expect(messages).toContain('Unknown node type "nope"')
    expect(messages).toContain('UV can\'t be used in a logic graph')
    expect(messages).toContain('Cross\'s input "a" has more than one edge')
    expect(messages).toContain('UV has no output "nothing"')
    expect(messages).toContain('Cross\'s input "a" takes vec3, not vec2')
    expect(messages).toContainEqual(expect.stringMatching(/loop: a, b/))
  })
})

describe('built-in nodes', () => {
  beforeAll(() => registerBuiltinNodes())
  afterAll(() => clearNodes())

  const run = (type: string, inputs: Record<string, any>, values: Record<string, any> = {}) =>
    getNode(type)!.eval!(inputs, {
      values,
      parameters: { speed: 4 },
      time: 2.5,
    })

  it('does math component wise, a number spreading over a vector', () => {
    expect(run('math.add', {
      a: [1, 2, 3],
      b: 1,
    })).toEqual({
      result: [2, 3, 4],
    })
    expect(run('math.mix', {
      a: 0,
      b: [10, 20],
      t: 0.5,
    })).toEqual({
      result: [5, 10],
    })
    expect(run('math.clamp', {
      x: [-1, 0.5, 2],
      min: 0,
      max: 1,
    })).toEqual({
      result: [0, 0.5, 1],
    })
    expect(run('math.remap', {
      x: 5,
      inMin: 0,
      inMax: 10,
      outMin: 0,
      outMax: 1,
    })).toEqual({ result: 0.5 })
    expect(run('math.smoothstep', { edge0: 0, edge1: 0, x: 0.3 })).toEqual({ result: 1 })
  })

  it('does vectors', () => {
    expect(run('vector.length', {
      vector: [3, 4],
    })).toEqual({ length: 5 })
    expect(run('vector.cross', {
      a: [1, 0, 0],
      b: [0, 1, 0],
    })).toEqual({
      result: [0, 0, 1],
    })
    expect(run('vector.split', {
      vector: [1, 2, 3],
    })).toEqual({ x: 1, y: 2, z: 3, w: 0 })
    expect(run('vector.combine3', { x: 1, y: 2, z: 3 })).toEqual({
      vector: [1, 2, 3],
    })
    expect(run('vector.normalize', {
      vector: [0, 2, 0],
    })).toEqual({
      result: [0, 1, 0],
    })
  })

  it('reads time, parameters and constants', () => {
    expect(run('input.time', {})).toEqual({ seconds: 2.5 })
    expect(run('input.parameter', {}, { name: 'speed' })).toEqual({ value: 4 })
    expect(run('input.vec3', {}, {
      value: [1, 2, 3],
    })).toEqual({
      value: [1, 2, 3],
    })
  })

  it('keeps material only nodes out of logic graphs', () => {
    const logic = getNodes('logic').map(node => node.type)
    expect(logic).toContain('math.add')
    expect(logic).not.toContain('material.output')
    expect(getNodes('material').map(node => node.type)).toContain('material.output')
  })
})

describe('graph files', () => {
  let root: string
  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), 'mavon-graphs-'))
  })
  afterAll(() => rmSync(root, { recursive: true, force: true }))

  it('writes and reads graphs/<name>.graph.json', () => {
    const file = graphFilePath(root, 'lava')
    expect(file).toBe(join(root, 'graphs', 'lava.graph.json'))
    writeGraphFile(file, {
      kind: 'material',
      nodes: [
        { id: 'out', type: 'material.output' },
      ],
    })
    expect(readGraphFile(file)).toMatchObject({
      name: 'lava',
      kind: 'material',
      nodes: [
        { id: 'out' },
      ],
    })
    expect(() => graphFilePath(root, '../evil')).toThrow('Invalid graph name')
  })
})

describe('graph names', () => {
  it('tells project graphs from plugins\' and finds their URL', async () => {
    const { parseGraphData: _, ...types } = await import('../../src/Graph/types')
    expect(types.parseGraphName('lava')).toEqual({ name: 'lava' })
    expect(types.parseGraphName('@acme/water:ocean')).toEqual({ plugin: '@acme/water', name: 'ocean' })
    expect(types.parseGraphName('forest:sway')).toEqual({ plugin: 'forest', name: 'sway' })
    expect(types.parseGraphName('../evil')).toBeUndefined()
    expect(types.parseGraphName('a:../b')).toBeUndefined()
    expect(types.graphUrl('lava')).toBe('/graphs/lava.graph.json')
    expect(types.graphUrl('@acme/water:ocean')).toBe('/graphs/@acme/water/ocean.graph.json')
    expect(() => types.graphUrl('no way')).toThrow('Invalid graph name')
  })
})
