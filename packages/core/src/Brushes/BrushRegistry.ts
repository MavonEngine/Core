import type { Object3D, Vector3 } from 'three'
import type { ScatterBrush } from '../Scatter/scatterBrush'
import type ScatterLayer from '../Scatter/ScatterLayer'
import type GameScene from '../Scene/GameScene'
import type Terrain from '../Terrain/Terrain'

/*
 * The editor's brushes: sculpting, painting terrain layers and scattering assets come with the engine, and plugins
 * add their own with `ctx.registerBrush()`. A brush gets a stroke's stamps (the editor spaces them along the drag)
 * and hands back how to undo the stroke.
 */

export interface BrushHit {
  /** World position */
  point: Vector3
  /** World normal, unit length */
  normal: Vector3
  /** The terrain under the brush, when it is on one */
  terrain?: Terrain
  /** The mesh under the brush, when it isn't a terrain */
  object?: Object3D
}

/** Settings every brush has, set in the editor's Brushes panel */
export interface BrushCommonSettings {
  /** Meters */
  radius: number
  /** 0 – 1 */
  strength: number
  /** 0 – 1, how soft the edge is */
  falloff: number
}

/** A setting a brush adds to the panel, stored under `key` */
export type BrushOption
  = | { type: 'slider', key: string, label: string, min: number, max: number, step: number, default: number }
    | { type: 'checkbox', key: string, label: string, default: boolean }
    | { type: 'select', key: string, label: string, options: { value: string, label: string }[], default: string }

export interface BrushContext {
  scene: GameScene
  settings: BrushCommonSettings
  /** The brush's own options, by key, see `BrushDefinition.options` */
  options: Record<string, unknown>
  /** Shift is held: do the opposite (lower instead of raise, erase instead of paint) */
  invert: boolean
  /** The layer picked in the panel's layer list, for brushes that paint terrain layers */
  paintLayer: number
  /** The scatter brush picked in the panel, for brushes that place assets */
  scatterBrush?: ScatterBrush
  /** The scene's scatter layer, made when `create` and there is none yet */
  scatterLayer(create?: boolean): ScatterLayer | undefined
  /** The surface straight below a world point, terrains and meshes, or undefined */
  surfaceBelow(point: Vector3): BrushHit | undefined
  random(): number
  logger?: { warn(message: string): void }
}

export interface BrushUndo {
  undo(): void
  redo(): void
}

/** A stroke being painted, from pointer down to pointer up */
export interface BrushStroke {
  /** One stamp at `hit` */
  stamp(hit: BrushHit, context: BrushContext): void
  /** Called once per frame while painting, e.g. to redraw what the stamps changed */
  frame?(): void
  /** The stroke is done. Return how to undo it, or nothing when it changed nothing */
  end(context: BrushContext): BrushUndo | void
}

export interface BrushDefinition {
  name: string
  /** Shown in the editor. Defaults to `name` */
  label?: string
  /** npm package of the plugin that registered it, unset for the built-in brushes */
  plugin?: string
  /** The tab it shows under in the Brushes panel, e.g. 'Sculpt', 'Paint', 'Scatter' or a plugin's own */
  group: string
  /** SVG path data (24×24 viewBox, stroked) for its button */
  icon?: string[]
  /** One line on what it does, shown as its tooltip */
  description?: string
  /** 'terrain' only works on terrains; 'surface' on any mesh. Decides what the brush's ray hits */
  target: 'terrain' | 'surface'
  /** Brush ring colour */
  color?: number
  /** The panel shows these for the brush. The values reach the stroke as `context.options` */
  options?: BrushOption[]
  /** Which of the panel's sections it needs */
  uses?: { layers?: boolean, scatterBrush?: boolean }
  /** One stroke, starting at `hit`. Return undefined to not start one (e.g. nothing to paint on) */
  begin(hit: BrushHit, context: BrushContext): BrushStroke | undefined
}

const registry = new Map<string, BrushDefinition>()
const listeners = new Set<() => void>()

export function brushKey(brush: Pick<BrushDefinition, 'name' | 'plugin'>): string {
  return brush.plugin
    ? `${brush.plugin}:${brush.name}`
    : brush.name
}

/** Add a brush to the editor. Registering the same name again replaces it */
export function registerBrush(brush: BrushDefinition): string {
  const key = brushKey(brush)
  registry.set(key, brush)
  listeners.forEach(listener => listener())
  return key
}

export function unregisterBrush(key: string): void {
  if (registry.delete(key))
    listeners.forEach(listener => listener())
}

/** Built-in brushes first, then plugins' grouped by plugin, each in registration order */
export function getBrushes(): (BrushDefinition & { key: string })[] {
  const all = Array.from(registry.entries(), ([key, brush]) => ({ ...brush, key }))
  return [
    ...all.filter(b => !b.plugin),
    ...all.filter(b => b.plugin).sort((a, b) => a.plugin!.localeCompare(b.plugin!)),
  ]
}

export function getBrush(key: string): BrushDefinition | undefined {
  return registry.get(key)
}

/** Called when brushes are registered or removed */
export function subscribeBrushes(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

/** The default value of each of a brush's options */
export function brushOptionDefaults(brush: Pick<BrushDefinition, 'options'>): Record<string, unknown> {
  return Object.fromEntries((brush.options ?? []).map(option => [option.key, option.default]))
}
