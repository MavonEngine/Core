import type { GridRegion, Heightmap } from './terrainData'
import { brushFalloff } from './splatMap'

/*
 * The sculpt brushes, as stamps on a heightmap. Positions and sizes are in the terrain's local meters.
 */

export type SculptMode = 'raise' | 'lower' | 'smooth' | 'flatten' | 'noise'

export interface SculptStamp {
  mode: SculptMode
  x: number
  z: number
  radius: number
  falloff: number
  /** 0 – 1 */
  strength: number
  /** Flatten: the height to level to, usually where the stroke started */
  target?: number
  /** Noise: features per meter */
  noiseScale?: number
  seed?: number
}

/** How far one stamp at full strength raises the ground, as a part of the brush's radius */
const RAISE_PER_STAMP = 0.04

function hash(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 2147483647) | 0
  h = Math.imul(h ^ (h >>> 13), 1274126177)
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296
}

/** Smooth value noise, 0 – 1 */
function valueNoise(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x)
  const y0 = Math.floor(y)
  const fx = x - x0
  const fy = y - y0
  const sx = fx * fx * (3 - 2 * fx)
  const sy = fy * fy * (3 - 2 * fy)
  const a = hash(x0, y0, seed)
  const b = hash(x0 + 1, y0, seed)
  const c = hash(x0, y0 + 1, seed)
  const d = hash(x0 + 1, y0 + 1, seed)
  return (a * (1 - sx) + b * sx) * (1 - sy) + (c * (1 - sx) + d * sx) * sy
}

/** The samples a stamp reaches */
export function sculptRegion(heightmap: Heightmap, x: number, z: number, radius: number): GridRegion | undefined {
  const [gx, gz] = heightmap.toGrid(x, z)
  const r = radius / heightmap.spacing
  const max = heightmap.resolution - 1
  const region = {
    col0: Math.max(0, Math.floor(gx - r)),
    row0: Math.max(0, Math.floor(gz - r)),
    col1: Math.min(max, Math.ceil(gx + r)),
    row1: Math.min(max, Math.ceil(gz + r)),
  }
  return region.col0 > region.col1 || region.row0 > region.row1
    ? undefined
    : region
}

/** Apply one stamp. Returns the samples it changed */
export function sculpt(heightmap: Heightmap, stamp: SculptStamp): GridRegion | undefined {
  const region = sculptRegion(heightmap, stamp.x, stamp.z, stamp.radius)
  if (!region)
    return undefined

  const strength = Math.min(1, Math.max(0, stamp.strength))
  // Smooth reads the heights before this stamp changed any: the region and a sample around it
  const n = heightmap.resolution
  const around: GridRegion = {
    col0: Math.max(0, region.col0 - 1),
    row0: Math.max(0, region.row0 - 1),
    col1: Math.min(n - 1, region.col1 + 1),
    row1: Math.min(n - 1, region.row1 + 1),
  }
  const before = stamp.mode === 'smooth'
    ? snapshotHeights(heightmap, around)
    : undefined
  const width = around.col1 - around.col0 + 1
  const at = (col: number, row: number) => {
    const c = Math.min(around.col1, Math.max(around.col0, col)) - around.col0
    const r = Math.min(around.row1, Math.max(around.row0, row)) - around.row0
    return before![r * width + c]
  }

  for (let row = region.row0; row <= region.row1; row++) {
    for (let col = region.col0; col <= region.col1; col++) {
      const x = heightmap.x(col)
      const z = heightmap.z(row)
      const f = brushFalloff(Math.hypot(x - stamp.x, z - stamp.z), stamp.radius, stamp.falloff)
      if (f <= 0)
        continue
      const h = heightmap.get(col, row)
      const amount = strength * f
      switch (stamp.mode) {
        case 'raise':
        case 'lower': {
          const step = amount * stamp.radius * RAISE_PER_STAMP
          heightmap.set(col, row, h + (stamp.mode === 'raise'
            ? step
            : -step))
          break
        }
        case 'smooth': {
          let sum = 0
          for (let dr = -1; dr <= 1; dr++) {
            for (let dc = -1; dc <= 1; dc++)
              sum += at(col + dc, row + dr)
          }
          heightmap.set(col, row, h + (sum / 9 - h) * amount)
          break
        }
        case 'flatten':
          heightmap.set(col, row, h + ((stamp.target ?? h) - h) * amount)
          break
        case 'noise': {
          const scale = stamp.noiseScale ?? 0.15
          const noise = valueNoise(x * scale, z * scale, stamp.seed ?? 1) * 2 - 1
          heightmap.set(col, row, h + noise * amount * stamp.radius * RAISE_PER_STAMP)
          break
        }
      }
    }
  }
  return region
}

/** A copy of a region's heights, to put back with `restoreHeights()` */
export function snapshotHeights(heightmap: Heightmap, region: GridRegion): Float32Array {
  const width = region.col1 - region.col0 + 1
  const n = heightmap.resolution
  const out = new Float32Array(width * (region.row1 - region.row0 + 1))
  for (let row = region.row0; row <= region.row1; row++)
    out.set(heightmap.heights.subarray(row * n + region.col0, row * n + region.col1 + 1), (row - region.row0) * width)
  return out
}

export function restoreHeights(heightmap: Heightmap, region: GridRegion, snapshot: Float32Array): void {
  const width = region.col1 - region.col0 + 1
  const n = heightmap.resolution
  for (let row = region.row0; row <= region.row1; row++)
    heightmap.heights.set(snapshot.subarray((row - region.row0) * width, (row - region.row0 + 1) * width), row * n + region.col0)
}

/** The smallest region holding both */
export function unionRegion(a: GridRegion | undefined, b: GridRegion | undefined): GridRegion | undefined {
  if (!a)
    return b
  if (!b)
    return a
  return {
    col0: Math.min(a.col0, b.col0),
    row0: Math.min(a.row0, b.row0),
    col1: Math.max(a.col1, b.col1),
    row1: Math.max(a.row1, b.row1),
  }
}
