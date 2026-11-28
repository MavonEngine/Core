import type { ScatterColliderShape, ScatterInstance } from './scatterData'
import { Quaternion, Vector3 } from 'three'

/*
 * A scatter brush: which assets it paints and how, each with its own placement rules. Saved in the project as
 * `brushes/<name>.brush.json`, so one brush can be used in every scene.
 */

export const BRUSHES_DIR = 'brushes'
export const BRUSH_FILE_SUFFIX = '.brush.json'
/** Brush names: letters, digits, `-` and `_` */
export const BRUSH_NAME_RE = /^[\w-]+$/

export type ScaleMode = 'uniform' | 'free' | 'lockXZ'

export interface ScatterBrushEntry {
  /** Name of a gltfModel resource */
  asset: string
  /** How often it is picked against the brush's other entries */
  weight: number
  /** Instances per 100 m² at full paint density */
  density: number
  /** Meters to keep from other instances of this asset */
  minSpacing: number
  scale: { min: number, max: number, mode: ScaleMode }
  randomYaw: boolean
  /** Degrees an instance may lean at random */
  randomPitch: number
  /** 0 stands up straight, 1 follows the surface's slope */
  alignToNormal: number
  /** Degrees: only on ground this steep */
  slope: [number, number]
  /** World height in meters: only between these */
  height: [number, number]
  /** Meters to move it along its up axis, negative sinks it in */
  zOffset: [number, number]
  /** Only where a terrain layer (by its material graph) covers at least `minWeight` */
  layerFilter?: { graph: string, minWeight: number }
  collision: boolean
  collider: { shape: ScatterColliderShape, fit: number }
  castShadow: boolean
  receiveShadow: boolean
}

export interface ScatterBrush {
  version: 1
  kind: 'scatter'
  name: string
  entries: ScatterBrushEntry[]
}

export function defaultBrushEntry(asset: string): ScatterBrushEntry {
  return {
    asset,
    weight: 1,
    density: 4,
    minSpacing: 1,
    scale: { min: 0.8, max: 1.2, mode: 'uniform' },
    randomYaw: true,
    randomPitch: 0,
    alignToNormal: 0,
    slope: [0, 45],
    height: [-10_000, 10_000],
    zOffset: [0, 0],
    collision: true,
    collider: { shape: 'box', fit: 0.9 },
    castShadow: true,
    receiveShadow: true,
  }
}

function num(v: unknown, fallback: number, min = -Infinity, max = Infinity): number {
  return typeof v === 'number' && Number.isFinite(v)
    ? Math.min(max, Math.max(min, v))
    : fallback
}

function range(v: unknown, fallback: [number, number], min = -Infinity, max = Infinity): [number, number] {
  if (!Array.isArray(v) || v.length !== 2)
    return fallback
  const a = num(v[0], fallback[0], min, max)
  const b = num(v[1], fallback[1], min, max)
  return a <= b
    ? [a, b]
    : [b, a]
}

const SCALE_MODES: ScaleMode[] = ['uniform', 'free', 'lockXZ']
const SHAPES: ScatterColliderShape[] = ['none', 'box', 'cylinder', 'sphere']

function entryFrom(value: unknown): ScatterBrushEntry | undefined {
  if (!value || typeof value !== 'object')
    return undefined
  const raw = value as Record<string, any>
  if (typeof raw.asset !== 'string' || !raw.asset)
    return undefined
  const d = defaultBrushEntry(raw.asset)
  const scaleMin = num(raw.scale?.min, d.scale.min, 0.001)
  const scaleMax = num(raw.scale?.max, d.scale.max, 0.001)
  return {
    asset: raw.asset,
    weight: num(raw.weight, d.weight, 0),
    density: num(raw.density, d.density, 0, 100_000),
    minSpacing: num(raw.minSpacing, d.minSpacing, 0),
    scale: {
      min: Math.min(scaleMin, scaleMax),
      max: Math.max(scaleMin, scaleMax),
      mode: SCALE_MODES.includes(raw.scale?.mode)
        ? raw.scale.mode
        : 'uniform',
    },
    randomYaw: raw.randomYaw !== false,
    randomPitch: num(raw.randomPitch, d.randomPitch, 0, 90),
    alignToNormal: num(raw.alignToNormal, d.alignToNormal, 0, 1),
    slope: range(raw.slope, d.slope, 0, 90),
    height: range(raw.height, d.height),
    zOffset: range(raw.zOffset, d.zOffset),
    layerFilter: raw.layerFilter && typeof raw.layerFilter.graph === 'string' && raw.layerFilter.graph
      ? {
          graph: raw.layerFilter.graph,
          minWeight: num(raw.layerFilter.minWeight, 0.5, 0, 1),
        }
      : undefined,
    collision: raw.collision !== false,
    collider: {
      shape: SHAPES.includes(raw.collider?.shape)
        ? raw.collider.shape
        : d.collider.shape,
      fit: num(raw.collider?.fit, d.collider.fit, 0.01, 2),
    },
    castShadow: raw.castShadow !== false,
    receiveShadow: raw.receiveShadow !== false,
  }
}

/** A brush from its file's JSON, with defaults for what is missing. Throws when it isn't a scatter brush */
export function parseScatterBrush(value: unknown, fallbackName = 'brush'): ScatterBrush {
  if (!value || typeof value !== 'object')
    throw new Error('A brush must be a JSON object')
  const raw = value as Record<string, unknown>
  if (raw.kind !== undefined && raw.kind !== 'scatter')
    throw new Error(`Unknown brush kind "${String(raw.kind)}"`)
  return {
    version: 1,
    kind: 'scatter',
    name: typeof raw.name === 'string' && raw.name
      ? raw.name
      : fallbackName,
    entries: Array.isArray(raw.entries)
      ? raw.entries.map(entryFrom).filter((e): e is ScatterBrushEntry => !!e)
      : [],
  }
}

/** One of the entries, by weight. Undefined when none has any */
export function pickEntry(entries: ScatterBrushEntry[], random: () => number): ScatterBrushEntry | undefined {
  const total = entries.reduce((sum, e) => sum + e.weight, 0)
  if (total <= 0)
    return undefined
  let r = random() * total
  for (const entry of entries) {
    r -= entry.weight
    if (r < 0)
      return entry
  }
  return entries[entries.length - 1]
}

export interface SurfaceHit {
  /** World position */
  point: Vector3
  /** World normal, unit length */
  normal: Vector3
  /** Weight of a terrain layer at the point, by its graph. Unset off a terrain */
  layerWeight?(graph: string): number
}

const UP = new Vector3(0, 1, 0)
const DEG = Math.PI / 180

/**
 * Where and how an instance of `entry` goes at `hit`, or undefined when the entry's filters (slope, height, layer)
 * leave the spot out. Spacing to other instances is the caller's to check
 */
export function placeInstance(entry: ScatterBrushEntry, hit: SurfaceHit, random: () => number): ScatterInstance | undefined {
  const slope = Math.acos(Math.min(1, Math.max(-1, hit.normal.dot(UP)))) / DEG
  if (slope < entry.slope[0] - 1e-6 || slope > entry.slope[1] + 1e-6)
    return undefined
  if (hit.point.y < entry.height[0] || hit.point.y > entry.height[1])
    return undefined
  if (entry.layerFilter && (hit.layerWeight?.(entry.layerFilter.graph) ?? 0) < entry.layerFilter.minWeight)
    return undefined

  const between = (a: number, b: number) => a + random() * (b - a)

  // Stand up between straight and the surface's normal, turn about that, then lean
  const up = UP.clone().lerp(hit.normal, entry.alignToNormal).normalize()
  const quaternion = new Quaternion().setFromUnitVectors(UP, up)
  if (entry.randomYaw)
    quaternion.multiply(new Quaternion().setFromAxisAngle(UP, random() * Math.PI * 2))
  if (entry.randomPitch > 0) {
    const axisAngle = random() * Math.PI * 2
    const axis = new Vector3(Math.cos(axisAngle), 0, Math.sin(axisAngle))
    quaternion.multiply(new Quaternion().setFromAxisAngle(axis, random() * entry.randomPitch * DEG))
  }

  const { min, max, mode } = entry.scale
  const s = between(min, max)
  const scale = mode === 'free'
    ? new Vector3(s, between(min, max), between(min, max))
    : mode === 'lockXZ'
      ? new Vector3(s, between(min, max), s)
      : new Vector3(s, s, s)

  const position = hit.point.clone().addScaledVector(up, between(entry.zOffset[0], entry.zOffset[1]))
  return { position, quaternion, scale }
}

/** How many instances of `entry` a disc of `radius` meters holds at `paintDensity` (0 – 1) */
export function targetCount(entry: Pick<ScatterBrushEntry, 'density'>, radius: number, paintDensity: number): number {
  return entry.density * Math.PI * radius * radius / 100 * paintDensity
}
