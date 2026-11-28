import { compileMaterialGraph } from '@mavonengine/core/Graph/Material/compileMaterialGraph'
import { registerTslNode } from '@mavonengine/core/Graph/Material/tslNodes'
import { registerNode } from '@mavonengine/core/Graph/NodeRegistry'
import { registerBuiltinNodes } from '@mavonengine/core/Graph/Nodes/builtin'
import { analyzeGraph } from '@mavonengine/core/Graph/validate'
import { Texture } from 'three'
import { beforeAll, describe, expect, it } from 'vitest'
import { normalMapNode, normalMapTsl } from '../src/nodes'
import { importedAssets, importedResources, NORMAL_MAP_NODE, PACKAGE, textureGraph, textureResource } from '../src/shared'

beforeAll(() => {
  registerBuiltinNodes()
  registerNode({ ...normalMapNode, type: NORMAL_MAP_NODE, plugin: PACKAGE })
  registerTslNode(NORMAL_MAP_NODE, normalMapTsl)
})

describe('textureGraph', () => {
  it('wires every map into the output without issues', () => {
    const graph = textureGraph('rock_wall', ['diff', 'nor', 'arm'])
    expect(analyzeGraph(graph).issues).toEqual([])

    const into = (port: string) => graph.edges.find(edge => edge.to.node === 'output' && edge.to.port === port)?.from
    expect(into('color')).toEqual({ node: 'diff_1', port: 'rgb' })
    expect(into('roughness')).toEqual({ node: 'armSplit_1', port: 'y' })
    expect(into('metalness')).toEqual({ node: 'armSplit_1', port: 'z' })
    expect(into('normal')).toEqual({ node: 'normalMap_1', port: 'normal' })
    expect(graph.nodes.find(node => node.id === 'diff_1')?.values?.texture).toBe(textureResource('rock_wall', 'diff'))
    expect(graph.parameters).toEqual([
      { name: 'tiling', type: 'float', default: 1 },
    ])
  })

  it('leaves out the maps an asset lacks', () => {
    const graph = textureGraph('plain', ['diff'])
    expect(analyzeGraph(graph).issues).toEqual([])
    expect(graph.nodes.map(node => node.id)).not.toContain('normalMap_1')
    expect(graph.edges.some(edge => edge.to.port === 'roughness')).toBe(false)
  })

  it('compiles to a material using the imported textures', () => {
    const textures = new Map(['diff', 'nor', 'arm'].map(map => [
      `polyhaven_rock_wall_${map}`,
      new Texture(),
    ]))
    const compiled = compileMaterialGraph(textureGraph('rock_wall', ['diff', 'nor', 'arm']), {
      textures: name => textures.get(name),
    })
    expect(compiled.material.colorNode).toBeTruthy()
    expect(compiled.material.normalNode).toBeTruthy()
    expect(compiled.material.roughnessNode).toBeTruthy()
  })
})

describe('imported assets', () => {
  it('become the game\'s resources', () => {
    const imported = importedAssets({
      imported: [
        {
          id: 'rock_wall',
          kind: 'textures',
          name: 'Rock Wall',
          resolution: '1k',
          files: { diff: '/polyhaven/rock_wall/d.jpg', nor: '/polyhaven/rock_wall/n.jpg' },
        },
        {
          id: 'crate',
          kind: 'models',
          name: 'Crate',
          resolution: '2k',
          files: { gltf: '/polyhaven/crate/crate_2k.gltf' },
        },
        {
          id: '../evil',
          kind: 'textures',
          name: 'x',
          resolution: '1k',
          files: {},
        },
        'nonsense',
      ],
    })
    expect(importedResources(imported)).toEqual([
      { name: 'polyhaven_rock_wall_diff', type: 'texture', path: '/polyhaven/rock_wall/d.jpg' },
      { name: 'polyhaven_rock_wall_nor', type: 'texture', path: '/polyhaven/rock_wall/n.jpg' },
      { name: 'polyhaven_crate', type: 'gltfModel', path: '/polyhaven/crate/crate_2k.gltf' },
    ])
  })
})
