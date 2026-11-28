import { BufferAttribute, BufferGeometry } from 'three'
import { decodeFloat32, encodeFloat32 } from './codec'

/*
 * A terrain's data, without anything that renders it, so the server can build its collider from the same heights.
 *
 * The terrain is a square of `size` meters around its position. Its heights are a grid of `resolution` × `resolution`
 * samples, row by row: row 0 at local z = -size/2, column 0 at local x = -size/2. UVs follow the grid (u along x,
 * v along z), which is also how the splatmap's texels map onto it.
 */

/** Scene object type of a terrain */
export const TERRAIN_TYPE = 'Terrain'

export interface TerrainLayer {
  /** Name of a material graph, `graphs/<name>.graph.json` */
  graph: string
  /** Times the layer's textures repeat across the whole terrain. Given to the graph's `tiling` parameter */
  tiling: number
}

export interface TerrainProps {
  /** Width and depth in meters */
  size: number
  /** Height samples per side */
  resolution: number
  /** The heights in meters, see `encodeHeights()`. Flat without */
  heights?: string
  /** Splatmap texels per side */
  splatResolution: number
  /** One encoded RGBA splatmap per 4 layers, see SplatMap */
  splat?: string[]
  layers: TerrainLayer[]
  /**
   * How sharp the edges between layers are. 0 blends by the painted weights only; higher lets each layer's brightness
   * (a stand-in for its height) decide, so the gaps between stones fill with dirt first
   */
  blendSharpness: number
  collision: boolean
  castShadow: boolean
  receiveShadow: boolean
}

/** Splatmap texels per meter when the resolution is picked for a size, see `splatResolutionFor()` */
export const SPLAT_TEXELS_PER_METER = 5
export const MIN_SPLAT_RESOLUTION = 256
export const MAX_SPLAT_RESOLUTION = 4096
export const MIN_HEIGHT_RESOLUTION = 3
export const MAX_HEIGHT_RESOLUTION = 1025

export const TERRAIN_DEFAULTS: TerrainProps = {
  size: 200,
  resolution: 257,
  splatResolution: splatResolutionFor(200),
  layers: [],
  blendSharpness: 0.5,
  collision: true,
  castShadow: false,
  receiveShadow: true,
}

/**
 * The splatmap resolution for a terrain of `size` meters: `texelsPerMeter`, rounded up to a power of two and kept
 * within 256 – 4096. 200 m gives 1024, about 20 cm a texel
 */
export function splatResolutionFor(size: number, texelsPerMeter = SPLAT_TEXELS_PER_METER): number {
  const wanted = Math.max(1, Math.ceil(size * texelsPerMeter))
  const pow2 = 2 ** Math.ceil(Math.log2(wanted))
  return Math.min(MAX_SPLAT_RESOLUTION, Math.max(MIN_SPLAT_RESOLUTION, pow2))
}

function num(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(max, Math.max(min, v))
    : fallback
}

/** A terrain's props from its saved ones, with defaults for what is missing or broken */
export function terrainPropsFrom(props: Record<string, unknown> = {}): TerrainProps {
  const d = TERRAIN_DEFAULTS
  const size = num(props.size, d.size, 1, 100_000)
  const layers = Array.isArray(props.layers)
    ? props.layers
        .filter((l): l is { graph: string, tiling?: unknown } => !!l && typeof l === 'object' && typeof (l as TerrainLayer).graph === 'string')
        .map(l => ({
          graph: l.graph,
          tiling: num(l.tiling, 20, 0.01, 10_000),
        }))
    : []
  return {
    size,
    resolution: Math.round(num(props.resolution, d.resolution, MIN_HEIGHT_RESOLUTION, MAX_HEIGHT_RESOLUTION)),
    heights: typeof props.heights === 'string'
      ? props.heights
      : undefined,
    splatResolution: Math.round(num(props.splatResolution, splatResolutionFor(size), 16, MAX_SPLAT_RESOLUTION)),
    splat: Array.isArray(props.splat) && props.splat.every(s => typeof s === 'string')
      ? props.splat as string[]
      : undefined,
    layers,
    blendSharpness: num(props.blendSharpness, d.blendSharpness, 0, 1),
    collision: props.collision !== false,
    castShadow: props.castShadow === true,
    receiveShadow: props.receiveShadow !== false,
  }
}

/**
 * A grid of heights in meters over a square of `size` meters, centered on the origin
 */
export class Heightmap {
  readonly heights: Float32Array

  constructor(readonly resolution: number, readonly size: number, heights?: Float32Array) {
    if (heights && heights.length !== resolution * resolution)
      throw new Error(`A ${resolution}×${resolution} heightmap needs ${resolution * resolution} heights, got ${heights.length}`)
    this.heights = heights ?? new Float32Array(resolution * resolution)
  }

  /** From the saved props: flat when there are no heights, or they don't fit the resolution */
  static fromProps(props: Pick<TerrainProps, 'resolution' | 'size' | 'heights'>): Heightmap {
    if (props.heights) {
      try {
        const heights = decodeFloat32(props.heights)
        if (heights.length === props.resolution * props.resolution)
          return new Heightmap(props.resolution, props.size, heights)
      }
      catch {
        // Broken data: start flat rather than not load the scene
      }
    }
    return new Heightmap(props.resolution, props.size)
  }

  /** For the props, or undefined while it is flat, which keeps the scene file small */
  encode(): string | undefined {
    return this.heights.some(h => h !== 0)
      ? encodeFloat32(this.heights)
      : undefined
  }

  /** Meters between two samples */
  get spacing(): number {
    return this.size / (this.resolution - 1)
  }

  get(col: number, row: number): number {
    const r = this.resolution - 1
    return this.heights[Math.min(r, Math.max(0, row)) * this.resolution + Math.min(r, Math.max(0, col))]
  }

  set(col: number, row: number, height: number): void {
    this.heights[row * this.resolution + col] = height
  }

  /** Local x of a column */
  x(col: number): number {
    return col * this.spacing - this.size / 2
  }

  /** Local z of a row */
  z(row: number): number {
    return row * this.spacing - this.size / 2
  }

  /** Grid coordinates of a local position, fractional */
  toGrid(x: number, z: number): [number, number] {
    return [(x + this.size / 2) / this.spacing, (z + this.size / 2) / this.spacing]
  }

  /** The height at a local position, between the samples around it. Outside it is the nearest edge's */
  sample(x: number, z: number): number {
    const [gx, gz] = this.toGrid(x, z)
    const r = this.resolution - 1
    const cx = Math.min(r, Math.max(0, gx))
    const cz = Math.min(r, Math.max(0, gz))
    const c0 = Math.min(r - 1, Math.floor(cx))
    const r0 = Math.min(r - 1, Math.floor(cz))
    const fx = cx - c0
    const fz = cz - r0
    const h00 = this.get(c0, r0)
    const h10 = this.get(c0 + 1, r0)
    const h01 = this.get(c0, r0 + 1)
    const h11 = this.get(c0 + 1, r0 + 1)
    return (h00 * (1 - fx) + h10 * fx) * (1 - fz) + (h01 * (1 - fx) + h11 * fx) * fz
  }

  /** Normal at a sample, from its neighbours, as [x, y, z] */
  normal(col: number, row: number): [number, number, number] {
    const s = this.spacing
    const dx = (this.get(col + 1, row) - this.get(col - 1, row)) / (2 * s)
    const dz = (this.get(col, row + 1) - this.get(col, row - 1)) / (2 * s)
    const len = Math.hypot(dx, 1, dz)
    return [-dx / len, 1 / len, -dz / len]
  }

  /** The same surface with another number of samples */
  resample(resolution: number, size = this.size): Heightmap {
    const next = new Heightmap(resolution, size)
    const scale = this.size / size
    for (let row = 0; row < resolution; row++) {
      for (let col = 0; col < resolution; col++)
        next.set(col, row, this.sample(next.x(col) * scale, next.z(row) * scale))
    }
    return next
  }

  /** The heights in the order Rapier's heightfield takes them: column-major, rows along z */
  toColumnMajor(): Float32Array {
    const n = this.resolution
    const out = new Float32Array(n * n)
    for (let row = 0; row < n; row++) {
      for (let col = 0; col < n; col++)
        out[row + col * n] = this.heights[row * n + col]
    }
    return out
  }
}

/** A grid mesh of the heightmap, with UVs over the whole terrain */
export function buildTerrainGeometry(heightmap: Heightmap): BufferGeometry {
  const n = heightmap.resolution
  const positions = new Float32Array(n * n * 3)
  const normals = new Float32Array(n * n * 3)
  const uvs = new Float32Array(n * n * 2)
  for (let row = 0; row < n; row++) {
    for (let col = 0; col < n; col++) {
      const i = row * n + col
      uvs[i * 2] = col / (n - 1)
      uvs[i * 2 + 1] = row / (n - 1)
      positions[i * 3] = heightmap.x(col)
      positions[i * 3 + 2] = heightmap.z(row)
    }
  }

  const quads = (n - 1) * (n - 1)
  const index = n * n > 65535
    ? new Uint32Array(quads * 6)
    : new Uint16Array(quads * 6)
  let k = 0
  for (let row = 0; row < n - 1; row++) {
    for (let col = 0; col < n - 1; col++) {
      const a = row * n + col
      const b = a + 1
      const c = a + n
      const d = c + 1
      // Counter-clockwise seen from above (+y)
      index[k++] = a
      index[k++] = c
      index[k++] = b
      index[k++] = b
      index[k++] = c
      index[k++] = d
    }
  }

  const geometry = new BufferGeometry()
  geometry.setAttribute('position', new BufferAttribute(positions, 3))
  geometry.setAttribute('normal', new BufferAttribute(normals, 3))
  geometry.setAttribute('uv', new BufferAttribute(uvs, 2))
  geometry.setIndex(new BufferAttribute(index, 1))
  updateTerrainGeometry(geometry, heightmap)
  return geometry
}

/** A rectangle of samples, inclusive */
export interface GridRegion {
  col0: number
  row0: number
  col1: number
  row1: number
}

/** Write the heights (of a region, or all) into a geometry from `buildTerrainGeometry()`, and their normals */
export function updateTerrainGeometry(geometry: BufferGeometry, heightmap: Heightmap, region?: GridRegion): void {
  const n = heightmap.resolution
  const position = geometry.getAttribute('position') as BufferAttribute
  const normal = geometry.getAttribute('normal') as BufferAttribute
  // Normals one sample around the region change too
  const c0 = Math.max(0, (region?.col0 ?? 0) - 1)
  const r0 = Math.max(0, (region?.row0 ?? 0) - 1)
  const c1 = Math.min(n - 1, (region?.col1 ?? n - 1) + 1)
  const r1 = Math.min(n - 1, (region?.row1 ?? n - 1) + 1)
  for (let row = r0; row <= r1; row++) {
    for (let col = c0; col <= c1; col++) {
      const i = row * n + col
      position.array[i * 3 + 1] = heightmap.heights[i]
      const [nx, ny, nz] = heightmap.normal(col, row)
      normal.array[i * 3] = nx
      normal.array[i * 3 + 1] = ny
      normal.array[i * 3 + 2] = nz
    }
  }
  position.needsUpdate = true
  normal.needsUpdate = true
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
}
