import type { DataTexture, Texture } from 'three'
import type { TslNode } from '../Graph/Material/tslNodes'
import type { TerrainLayer } from './terrainData'
import { dot, float, normalize, normalView, pow, texture, uniform, uv, vec3 } from 'three/tsl'
import { MeshStandardNodeMaterial } from 'three/webgpu'
import Game from '../Game'
import { compileMaterialGraph } from '../Graph/Material/compileMaterialGraph'
import { materialGraphs } from '../Graph/Material/MaterialGraphs'

/*
 * A terrain's material: each layer's material graph compiled on its own (with the layer's tiling), mixed by the
 * splatmaps' weights. With blend sharpness each layer's brightness acts as its height, so a brighter layer (stones)
 * shows through a darker one (dirt) where both are painted.
 */

/** The terrain's colour when it has no layers */
const BARE_COLOR = 0x4A7C59

/** Uniforms of a terrain material, changed without building it again */
export interface TerrainMaterialUniforms {
  blendSharpness: { value: number }
}

interface LayerNodes {
  color: TslNode
  roughness: TslNode
  metalness: TslNode
  normal?: TslNode
}

function resourceTexture(name: string): Texture | undefined {
  const item = Game.instance().resources.items[name] as unknown
  return item && (item as Texture).isTexture
    ? item as Texture
    : undefined
}

/** One layer's graph as TSL nodes, with its tiling. A graph that can't be loaded shows magenta */
async function layerNodes(layer: TerrainLayer): Promise<LayerNodes> {
  try {
    // Loads the graph's subgraphs and waits for the resources the textures come from
    await materialGraphs.load(layer.graph)
    const graph = await materialGraphs.graph(layer.graph)
    const compiled = compileMaterialGraph(graph, {
      textures: resourceTexture,
      parameters: { tiling: layer.tiling },
    })
    const m = compiled.material
    const nodes = {
      color: m.colorNode ?? vec3(1, 1, 1),
      roughness: m.roughnessNode ?? float(1),
      metalness: m.metalnessNode ?? float(0),
      normal: m.normalNode ?? undefined,
    }
    // Only its nodes are used
    m.dispose()
    return nodes
  }
  catch (err) {
    Game.instance().logger?.warn(`Terrain layer "${layer.graph}": ${(err as Error).message}`)
    return {
      color: vec3(1, 0, 1),
      roughness: float(1),
      metalness: float(0),
    }
  }
}

/**
 * Build the material for `layers` over the splatmaps. Resolves once every layer's graph is compiled
 */
export async function buildTerrainMaterial(layers: TerrainLayer[], splatTextures: DataTexture[], uniforms: TerrainMaterialUniforms): Promise<MeshStandardNodeMaterial> {
  const material = new MeshStandardNodeMaterial({ color: BARE_COLOR, roughness: 1, metalness: 0 })
  material.name = 'Terrain'
  if (!layers.length)
    return material

  const nodes = await Promise.all(layers.map(layerNodes))
  const splat = splatTextures.map(map => texture(map, uv()))
  const sharpness = uniform(uniforms.blendSharpness.value)
  uniforms.blendSharpness = sharpness as unknown as { value: number }

  // Weight of each layer, sharpened by its brightness: w * (brightness + a little) ^ (sharpness * 8)
  const luminance = vec3(0.2126, 0.7152, 0.0722)
  const weights = nodes.map((layer, i) => {
    const channel = splat[i >> 2]?.[(['r', 'g', 'b', 'a'] as const)[i & 3]] ?? float(0)
    const height = dot(vec3(layer.color), luminance).add(0.05)
    return channel.mul(pow(height, sharpness.mul(8)))
  })
  const total = weights.reduce((sum: TslNode, w: TslNode) => sum.add(w), float(0)).max(1e-5)
  const mixed = (pick: (layer: LayerNodes) => TslNode) => nodes
    .map((layer, i) => pick(layer).mul(weights[i]))
    .reduce((sum: TslNode, v: TslNode) => sum.add(v))
    .div(total)

  material.colorNode = mixed(layer => vec3(layer.color))
  material.roughnessNode = mixed(layer => float(layer.roughness))
  material.metalnessNode = mixed(layer => float(layer.metalness))
  if (nodes.some(layer => layer.normal))
    material.normalNode = normalize(mixed(layer => layer.normal ?? normalView))
  return material
}
