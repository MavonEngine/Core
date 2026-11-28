import type { GridRegion } from './terrainData'
import { decodeBytes, encodeBytes } from './codec'

/*
 * How much of each layer covers a surface: one RGBA texel per spot, a channel per layer, four layers per map.
 * The weights of a texel add up to 1 (255). Pure data, the client uploads the maps as textures.
 */

/** Layers a splatmap holds at most: two maps */
export const MAX_SPLAT_LAYERS = 8

/**
 * How strongly a brush works at `distance` from its center: 1 inside its hard core, easing to 0 at `radius`.
 * `falloff` 0 is a hard edge, 1 eases from the center out
 */
export function brushFalloff(distance: number, radius: number, falloff: number): number {
  if (distance >= radius)
    return 0
  const inner = radius * (1 - Math.min(1, Math.max(0, falloff)))
  if (distance <= inner)
    return 1
  const t = (radius - distance) / (radius - inner)
  return t * t * (3 - 2 * t)
}

export type SplatPaintMode = 'paint' | 'erase' | 'smooth'

export interface SplatStroke {
  layer: number
  /** Center, in texels */
  x: number
  y: number
  /** In texels */
  radius: number
  falloff: number
  /** 0 – 1, how much of the way to full coverage one stamp goes */
  strength: number
  mode: SplatPaintMode
}

export class SplatMap {
  readonly maps: Uint8Array[]

  constructor(readonly resolution: number, layerCount: number, maps?: Uint8Array[]) {
    const count = Math.max(1, Math.ceil(Math.min(MAX_SPLAT_LAYERS, Math.max(1, layerCount)) / 4))
    const size = resolution * resolution * 4
    if (maps && maps.length >= count && maps.every(map => map.length === size)) {
      this.maps = maps.slice(0, count)
    }
    else {
      this.maps = Array.from({ length: count }, () => new Uint8Array(size))
      // All of the first layer
      for (let i = 0; i < size; i += 4)
        this.maps[0][i] = 255
    }
  }

  /** From the saved props. Missing or broken maps start covered by the first layer */
  static fromProps(resolution: number, layerCount: number, splat?: string[]): SplatMap {
    try {
      if (splat?.length)
        return new SplatMap(resolution, layerCount, splat.map(decodeBytes))
    }
    catch {
      // Broken data: start over rather than not load the scene
    }
    return new SplatMap(resolution, layerCount)
  }

  encode(): string[] {
    return this.maps.map(encodeBytes)
  }

  /** How many layers it has room for */
  get capacity(): number {
    return this.maps.length * 4
  }

  /** Make room for `layerCount` layers. New layers start empty */
  withLayers(layerCount: number): SplatMap {
    const count = Math.ceil(Math.min(MAX_SPLAT_LAYERS, Math.max(1, layerCount)) / 4)
    if (count === this.maps.length)
      return this
    const size = this.resolution * this.resolution * 4
    const maps = Array.from({ length: count }, (_, i) => this.maps[i] ?? new Uint8Array(size))
    return new SplatMap(this.resolution, count * 4, maps)
  }

  /**
   * Take a layer out: what it covered goes to the others in proportion, or to the first layer where it was alone.
   * The layers after it move down a channel
   */
  removeLayer(layer: number, layerCount: number): void {
    const weights = new Float32Array(this.capacity)
    const texels = this.resolution * this.resolution
    for (let t = 0; t < texels; t++) {
      this.read(t, weights)
      for (let l = layer; l < this.capacity - 1; l++)
        weights[l] = weights[l + 1]
      weights[this.capacity - 1] = 0
      if (layerCount - 1 > 0)
        normalize(weights, -1)
      this.write(t, weights)
    }
  }

  /** The weight of a layer at a texel, 0 – 1 */
  weight(layer: number, x: number, y: number): number {
    const xi = Math.min(this.resolution - 1, Math.max(0, Math.floor(x)))
    const yi = Math.min(this.resolution - 1, Math.max(0, Math.floor(y)))
    const map = this.maps[layer >> 2]
    return map
      ? map[(yi * this.resolution + xi) * 4 + (layer & 3)] / 255
      : 0
  }

  /** The weight of a layer at a UV coordinate, 0 – 1 */
  weightAtUv(layer: number, u: number, v: number): number {
    return this.weight(layer, u * this.resolution, v * this.resolution)
  }

  private read(texel: number, out: Float32Array): void {
    for (let l = 0; l < out.length; l++)
      out[l] = this.maps[l >> 2][texel * 4 + (l & 3)] / 255
  }

  private write(texel: number, weights: Float32Array): void {
    // Rounded so they still add up to 255: the largest takes what rounding leaves over
    let sum = 0
    let largest = 0
    for (let l = 0; l < weights.length; l++) {
      const byte = Math.round(weights[l] * 255)
      this.maps[l >> 2][texel * 4 + (l & 3)] = byte
      sum += byte
      if (weights[l] > weights[largest])
        largest = l
    }
    const map = this.maps[largest >> 2]
    const i = texel * 4 + (largest & 3)
    map[i] = Math.min(255, Math.max(0, map[i] + 255 - sum))
  }

  /** The texels a stroke touches */
  regionOf(stroke: Pick<SplatStroke, 'x' | 'y' | 'radius'>): GridRegion | undefined {
    const max = this.resolution - 1
    const region = {
      col0: Math.max(0, Math.floor(stroke.x - stroke.radius)),
      row0: Math.max(0, Math.floor(stroke.y - stroke.radius)),
      col1: Math.min(max, Math.ceil(stroke.x + stroke.radius)),
      row1: Math.min(max, Math.ceil(stroke.y + stroke.radius)),
    }
    return region.col0 > region.col1 || region.row0 > region.row1
      ? undefined
      : region
  }

  /** Paint one stamp. Returns the texels it changed */
  paint(stroke: SplatStroke): GridRegion | undefined {
    const region = this.regionOf(stroke)
    if (!region || stroke.layer < 0 || stroke.layer >= this.capacity)
      return undefined

    const weights = new Float32Array(this.capacity)
    const smoothed = stroke.mode === 'smooth'
      ? this.blurred(region)
      : undefined
    const width = region.col1 - region.col0 + 1

    for (let y = region.row0; y <= region.row1; y++) {
      for (let x = region.col0; x <= region.col1; x++) {
        const f = brushFalloff(Math.hypot(x + 0.5 - stroke.x, y + 0.5 - stroke.y), stroke.radius, stroke.falloff)
        if (f <= 0)
          continue
        const amount = Math.min(1, stroke.strength * f)
        const texel = y * this.resolution + x
        this.read(texel, weights)

        if (smoothed) {
          const base = ((y - region.row0) * width + (x - region.col0)) * this.capacity
          for (let l = 0; l < this.capacity; l++)
            weights[l] += (smoothed[base + l] - weights[l]) * amount
          normalize(weights, -1)
        }
        else if (stroke.mode === 'paint') {
          weights[stroke.layer] += (1 - weights[stroke.layer]) * amount
          normalize(weights, stroke.layer)
        }
        else {
          weights[stroke.layer] -= weights[stroke.layer] * amount
          normalize(weights, stroke.layer, stroke.layer)
        }
        this.write(texel, weights)
      }
    }
    return region
  }

  /** Cover every texel with one layer */
  fill(layer: number): void {
    const weights = new Float32Array(this.capacity)
    weights[layer] = 1
    for (let t = 0; t < this.resolution * this.resolution; t++)
      this.write(t, weights)
  }

  /** The weights of a region averaged over 5×5 texels, capacity floats per texel */
  private blurred(region: GridRegion): Float32Array {
    const width = region.col1 - region.col0 + 1
    const height = region.row1 - region.row0 + 1
    const out = new Float32Array(width * height * this.capacity)
    const weights = new Float32Array(this.capacity)
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const base = (y * width + x) * this.capacity
        let samples = 0
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const sx = region.col0 + x + dx
            const sy = region.row0 + y + dy
            if (sx < 0 || sy < 0 || sx >= this.resolution || sy >= this.resolution)
              continue
            this.read(sy * this.resolution + sx, weights)
            for (let l = 0; l < this.capacity; l++)
              out[base + l] += weights[l]
            samples++
          }
        }
        for (let l = 0; l < this.capacity; l++)
          out[base + l] /= samples
      }
    }
    return out
  }

  /** A copy of a region's texels, to put back with `restore()` */
  snapshot(region: GridRegion): Uint8Array[] {
    const width = region.col1 - region.col0 + 1
    return this.maps.map((map) => {
      const out = new Uint8Array(width * (region.row1 - region.row0 + 1) * 4)
      for (let y = region.row0; y <= region.row1; y++)
        out.set(map.subarray((y * this.resolution + region.col0) * 4, (y * this.resolution + region.col1 + 1) * 4), (y - region.row0) * width * 4)
      return out
    })
  }

  restore(region: GridRegion, snapshot: Uint8Array[]): void {
    const width = region.col1 - region.col0 + 1
    snapshot.forEach((data, m) => {
      const map = this.maps[m]
      if (!map)
        return
      for (let y = region.row0; y <= region.row1; y++)
        map.set(data.subarray((y - region.row0) * width * 4, (y - region.row0 + 1) * width * 4), (y * this.resolution + region.col0) * 4)
    })
  }

  /** The same coverage at another resolution, nearest texel */
  resample(resolution: number): SplatMap {
    const maps = this.maps.map((map) => {
      const out = new Uint8Array(resolution * resolution * 4)
      for (let y = 0; y < resolution; y++) {
        const sy = Math.min(this.resolution - 1, Math.floor((y + 0.5) * this.resolution / resolution))
        for (let x = 0; x < resolution; x++) {
          const sx = Math.min(this.resolution - 1, Math.floor((x + 0.5) * this.resolution / resolution))
          out.set(map.subarray((sy * this.resolution + sx) * 4, (sy * this.resolution + sx) * 4 + 4), (y * resolution + x) * 4)
        }
      }
      return out
    })
    return new SplatMap(resolution, this.capacity, maps)
  }
}

/**
 * Make the weights add up to 1 by scaling all but `keep` (which holds its value; -1 to scale them all).
 * When the others are all 0 what is missing goes to `fallback` (layer 0, or the next one when that is `except`)
 */
function normalize(weights: Float32Array, keep: number, except = -1): void {
  const kept = keep >= 0
    ? Math.min(1, Math.max(0, weights[keep]))
    : 0
  let others = 0
  for (let l = 0; l < weights.length; l++) {
    if (l !== keep)
      others += Math.max(0, weights[l])
  }
  const room = 1 - kept
  if (others > 1e-6) {
    const scale = room / others
    for (let l = 0; l < weights.length; l++) {
      if (l !== keep)
        weights[l] = Math.max(0, weights[l]) * scale
    }
  }
  else {
    for (let l = 0; l < weights.length; l++) {
      if (l !== keep)
        weights[l] = 0
    }
    const fallback = except === 0
      ? 1
      : 0
    if (fallback !== keep && fallback < weights.length)
      weights[fallback] = room
  }
  if (keep >= 0)
    weights[keep] = kept
}
