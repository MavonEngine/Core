import type { GraphData } from '@mavonengine/core/Graph/types'
import type { Asset } from '@mavonengine/core/Types/Asset'

/*
 * What the client and dev entries share: the kinds of assets, how an import is recorded in mavonengine.json, the
 * resource names and URLs it gets, and the material graph made for a texture. No Node or browser APIs here.
 */

export const PACKAGE = '@mavonengine/polyhaven'

/** Sent with every request to Poly Haven, which asks for a User-Agent naming the software (see their API terms) */
export const USER_AGENT = 'MavonEngine-PolyHaven/0.0.1 (+https://github.com/MavonEngine/Core)'

export const API_BASE = 'https://api.polyhaven.com'

/** The only host files are downloaded from: URLs come from the API's answers, so anything else is turned away */
export const DOWNLOAD_HOSTS = ['dl.polyhaven.org']

/** The kinds the panel browses and imports. Poly Haven's HDRIs need an HDR loader the engine doesn't have yet */
export type AssetKind = 'textures' | 'models'
export const ASSET_KINDS: AssetKind[] = ['textures', 'models']

export const RESOLUTIONS = ['1k', '2k', '4k', '8k'] as const
export type Resolution = typeof RESOLUTIONS[number]

/** Poly Haven ids are lowercase words with underscores, e.g. `aerial_asphalt_01`. Also safe as file and graph names */
export const ID_RE = /^[a-z0-9_]{1,80}$/

/** An asset in Poly Haven's list, the part the panel uses */
export interface PolyHavenAsset {
  id: string
  name: string
  categories: string[]
  tags: string[]
  authors: string[]
  /** Largest side in pixels, for textures */
  maxResolution?: number
  downloads: number
  published: number
}

/** The texture maps an import downloads, by Poly Haven's file key */
export const TEXTURE_MAPS = {
  /** Base color, sRGB */
  diff: 'Diffuse',
  /** OpenGL normal map, which three expects */
  nor: 'nor_gl',
  /** Ambient occlusion, roughness and metalness in r, g and b */
  arm: 'arm',
} as const
export type TextureMap = keyof typeof TEXTURE_MAPS

/** What an import added to the project, kept under `imported` in the plugin's options in mavonengine.json */
export interface ImportedAsset {
  id: string
  kind: AssetKind
  name: string
  resolution: Resolution
  /** URL path of each file the game loads: one per map for a texture, the .gltf for a model */
  files: Partial<Record<TextureMap | 'gltf', string>>
  /** The material graph made for a texture */
  graph?: string
}

export interface PolyHavenOptions {
  imported?: ImportedAsset[]
  /** Resolution the panel picks first. Default 1k */
  resolution?: Resolution
}

/** The imports recorded in the options, leaving out entries that don't look like one */
export function importedAssets(options: Record<string, unknown>): ImportedAsset[] {
  const list = (options as PolyHavenOptions).imported
  if (!Array.isArray(list))
    return []
  return list.filter(entry => entry
    && typeof entry === 'object'
    && typeof entry.id === 'string'
    && ID_RE.test(entry.id)
    && ASSET_KINDS.includes(entry.kind)
    && entry.files
    && typeof entry.files === 'object')
}

/** Resource name of a texture map, e.g. `polyhaven_rock_wall_diff`: what a Texture node picks */
export function textureResource(id: string, map: TextureMap): string {
  return `polyhaven_${id}_${map}`
}

/** Resource name of a model */
export function modelResource(id: string): string {
  return `polyhaven_${id}`
}

/** Name of the material graph made for a texture */
export function graphName(id: string): string {
  return `polyhaven_${id}`
}

/** Directory in the client's public directory an asset's files go to, and the URL path they are served at */
export function publicPath(id: string): string {
  return `polyhaven/${id}`
}

/** The resources the game loads for the imports */
export function importedResources(imported: ImportedAsset[]): Asset[] {
  return imported.flatMap((entry): Asset[] => {
    if (entry.kind === 'models') {
      return entry.files.gltf
        ? [
            {
              name: modelResource(entry.id),
              type: 'gltfModel',
              path: entry.files.gltf,
            },
          ]
        : []
    }
    return (Object.keys(TEXTURE_MAPS) as TextureMap[]).flatMap(map => entry.files[map]
      ? [
          {
            name: textureResource(entry.id, map),
            type: 'texture' as const,
            path: entry.files[map]!,
          },
        ]
      : [])
  })
}

/** The type of the Normal Map node this plugin registers, as graph files name it */
export const NORMAL_MAP_NODE = `${PACKAGE}:normalMap`

/**
 * A material graph for an imported texture: its maps sampled with tiled UVs, base color into the color, roughness and
 * metalness out of the ARM map, the normal map through the Normal Map node. `tiling` repeats the texture.
 */
export function textureGraph(id: string, maps: TextureMap[]): GraphData {
  const has = new Set(maps)
  const sample = (map: TextureMap, y: number) => ({
    id: `${map}_1`,
    type: 'texture.sample',
    position: [300, y] as [number, number],
    values: {
      texture: textureResource(id, map),
    },
  })

  const nodes: GraphData['nodes'] = [
    {
      id: 'uv_1',
      type: 'surface.uv',
      position: [-260, 0],
    },
    {
      id: 'tiling_1',
      type: 'input.parameter',
      position: [-260, 120],
      values: { name: 'tiling' },
    },
    {
      id: 'tiledUv_1',
      type: 'math.multiply',
      position: [20, 40],
    },
    {
      id: 'output',
      type: 'material.output',
      position: [960, 0],
    },
  ]
  const edges: GraphData['edges'] = [
    {
      from: { node: 'uv_1', port: 'value' },
      to: { node: 'tiledUv_1', port: 'a' },
    },
    {
      from: { node: 'tiling_1', port: 'value' },
      to: { node: 'tiledUv_1', port: 'b' },
    },
  ]
  const uvInto = (node: string) => edges.push({
    from: { node: 'tiledUv_1', port: 'result' },
    to: { node, port: 'uv' },
  })

  if (has.has('diff')) {
    nodes.push(sample('diff', -120))
    uvInto('diff_1')
    edges.push({
      from: { node: 'diff_1', port: 'rgb' },
      to: { node: 'output', port: 'color' },
    })
  }
  if (has.has('arm')) {
    nodes.push(sample('arm', 120), {
      id: 'armSplit_1',
      type: 'vector.split',
      position: [640, 120],
    })
    uvInto('arm_1')
    edges.push(
      {
        from: { node: 'arm_1', port: 'color' },
        to: { node: 'armSplit_1', port: 'vector' },
      },
      {
        from: { node: 'armSplit_1', port: 'y' },
        to: { node: 'output', port: 'roughness' },
      },
      {
        from: { node: 'armSplit_1', port: 'z' },
        to: { node: 'output', port: 'metalness' },
      },
    )
  }
  if (has.has('nor')) {
    nodes.push(sample('nor', 360), {
      id: 'normalMap_1',
      type: NORMAL_MAP_NODE,
      position: [640, 360],
    })
    uvInto('nor_1')
    edges.push(
      {
        from: { node: 'nor_1', port: 'rgb' },
        to: { node: 'normalMap_1', port: 'color' },
      },
      {
        from: { node: 'normalMap_1', port: 'normal' },
        to: { node: 'output', port: 'normal' },
      },
    )
  }

  return {
    version: 1,
    kind: 'material',
    name: graphName(id),
    nodes,
    edges,
    parameters: [
      { name: 'tiling', type: 'float', default: 1 },
    ],
  }
}

/** Poly Haven's thumbnail of an asset, which the dev entry fetches once and keeps */
export function thumbnailUrl(id: string): string {
  return `https://cdn.polyhaven.com/asset_img/thumbs/${id}.png?width=256&height=256`
}
