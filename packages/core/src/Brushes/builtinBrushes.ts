import type { ScatterBrushEntry } from '../Scatter/scatterBrush'
import type ScatterLayer from '../Scatter/ScatterLayer'
import type { SculptMode } from '../Terrain/sculpt'
import type { SplatPaintMode } from '../Terrain/splatMap'
import type Terrain from '../Terrain/Terrain'
import type { GridRegion } from '../Terrain/terrainData'
import type { BrushContext, BrushDefinition, BrushHit, BrushStroke } from './BrushRegistry'
import { Vector3 } from 'three'
import { pickEntry, placeInstance, targetCount } from '../Scatter/scatterBrush'
import { restoreHeights, sculpt, snapshotHeights, unionRegion } from '../Terrain/sculpt'
import { Heightmap } from '../Terrain/terrainData'
import { registerBrush } from './BrushRegistry'

/*
 * The brushes that come with the editor: sculpting and painting a terrain's layers, and painting, erasing and placing
 * single assets with a scatter brush. Registered like plugins register theirs.
 */

const SCULPT = 0x4A9EFF
const PAINT = 0xE0A040
const SCATTER = 0x5FD068

const ICONS = {
  raise: ['M12 19V5', 'M5 12l7-7 7 7'],
  lower: ['M12 5v14', 'M19 12l-7 7-7-7'],
  smooth: ['M3 12c3-4 6-4 9 0s6 4 9 0'],
  flatten: ['M3 15h18', 'M6 11h12'],
  noise: ['M3 14l3-5 3 7 3-9 3 8 3-4 3 3'],
  paint: ['M18 3l3 3-9 9H9v-3z', 'M9 15c-3 0-5 2-5 5h5'],
  erase: ['M16 3l5 5-11 11H5v-5z', 'M13 21h8'],
  scatter: [
    'M7 17a2 2 0 1 0 0-.1',
    'M17 7a2 2 0 1 0 0-.1',
    'M16 17a2 2 0 1 0 0-.1',
    'M7 7a2 2 0 1 0 0-.1',
  ],
  single: [
    'M12 12a3 3 0 1 0 0-.1',
    'M12 3v3',
    'M12 18v3',
    'M3 12h3',
    'M18 12h3',
  ],
}

/** A stroke that sculpts a terrain, undone by putting back the region it touched */
function sculptStroke(terrain: Terrain, mode: SculptMode, start: BrushHit): BrushStroke {
  const before = new Heightmap(terrain.heightmap.resolution, terrain.heightmap.size, terrain.heightmap.heights.slice())
  const target = terrain.toLocal(start.point).y
  let touched: GridRegion | undefined
  return {
    stamp(hit, context) {
      const local = terrain.toLocal(hit.point)
      const { radius, falloff, strength } = context.settings
      const flipped: SculptMode = context.invert && mode === 'raise'
        ? 'lower'
        : context.invert && mode === 'lower'
          ? 'raise'
          : mode
      const region = sculpt(terrain.heightmap, {
        mode: flipped,
        x: local.x,
        z: local.z,
        radius: radius / terrain.worldScale,
        falloff,
        strength,
        target,
        noiseScale: Number(context.options.noiseScale ?? 0.15),
        seed: 1,
      })
      if (region) {
        touched = unionRegion(touched, region)
        terrain.heightsChanged(region)
      }
    },
    end() {
      if (!touched)
        return
      const region = touched
      const old = snapshotHeights(before, region)
      const next = snapshotHeights(terrain.heightmap, region)
      terrain.commit()
      const put = (heights: Float32Array) => {
        restoreHeights(terrain.heightmap, region, heights)
        terrain.heightsChanged(region)
        terrain.commit()
      }
      return {
        undo: () => put(old),
        redo: () => put(next),
      }
    },
  }
}

function sculptBrush(mode: SculptMode, label: string, description: string): BrushDefinition {
  return {
    name: `sculpt.${mode}`,
    label,
    group: 'Sculpt',
    icon: ICONS[mode],
    description,
    target: 'terrain',
    color: SCULPT,
    options: mode === 'noise'
      ? [
          {
            type: 'slider',
            key: 'noiseScale',
            label: 'noise scale',
            min: 0.01,
            max: 2,
            step: 0.01,
            default: 0.15,
          },
        ]
      : undefined,
    begin: hit => hit.terrain
      ? sculptStroke(hit.terrain, mode, hit)
      : undefined,
  }
}

/** A stroke that paints a terrain's layers, undone by putting back the texels it touched */
function paintStroke(terrain: Terrain, mode: SplatPaintMode): BrushStroke {
  const before = terrain.splat.maps.map(map => map.slice())
  const splat = terrain.splat
  let touched: GridRegion | undefined
  return {
    stamp(hit, context) {
      const local = terrain.toLocal(hit.point)
      const [x, y] = terrain.texelAt(local)
      const { radius, falloff, strength } = context.settings
      const flipped: SplatPaintMode = context.invert && mode === 'paint'
        ? 'erase'
        : context.invert && mode === 'erase'
          ? 'paint'
          : mode
      const region = splat.paint({
        layer: Math.min(context.paintLayer, Math.max(0, terrain.layers.length - 1)),
        x,
        y,
        radius: terrain.metersToTexels(radius / terrain.worldScale),
        falloff,
        strength,
        mode: flipped,
      })
      if (region) {
        touched = unionRegion(touched, region)
        terrain.splatChanged()
      }
    },
    end() {
      if (!touched)
        return
      const region = touched
      const res = splat.resolution
      const width = region.col1 - region.col0 + 1
      const old = before.map((map) => {
        const out = new Uint8Array(width * (region.row1 - region.row0 + 1) * 4)
        for (let y = region.row0; y <= region.row1; y++)
          out.set(map.subarray((y * res + region.col0) * 4, (y * res + region.col1 + 1) * 4), (y - region.row0) * width * 4)
        return out
      })
      const next = splat.snapshot(region)
      const put = (data: Uint8Array[]) => {
        splat.restore(region, data)
        terrain.splatChanged()
      }
      return {
        undo: () => put(old),
        redo: () => put(next),
      }
    },
  }
}

function paintBrush(mode: SplatPaintMode, label: string, description: string): BrushDefinition {
  return {
    name: `paint.${mode}`,
    label,
    group: 'Paint',
    icon: ICONS[mode === 'smooth'
      ? 'smooth'
      : mode],
    description,
    target: 'terrain',
    color: PAINT,
    uses: { layers: true },
    begin: (hit, context) => {
      if (!hit.terrain)
        return undefined
      if (!hit.terrain.layers.length) {
        context.logger?.warn('Add a layer to the terrain before painting')
        return undefined
      }
      return paintStroke(hit.terrain, mode)
    },
  }
}

/** Put one instance of `entry` at `hit` when the spot passes its filters and spacing */
export function placeEntry(layer: ScatterLayer, entry: ScatterBrushEntry, hit: BrushHit, random: () => number): boolean {
  if (!layer.ensureGroup(entry) || layer.crowded(hit.point, entry.minSpacing, entry.asset))
    return false
  const terrain = hit.terrain
  const instance = placeInstance(entry, {
    point: hit.point,
    normal: hit.normal,
    layerWeight: terrain
      ? graph => terrain.layerWeightAt(hit.point, graph)
      : undefined,
  }, random)
  if (!instance)
    return false
  layer.add(entry.asset, instance)
  return true
}

/** Fill a disc around `hit` up to each entry's density, keeping what is there */
export function scatterDisc(layer: ScatterLayer, entries: ScatterBrushEntry[], hit: BrushHit, context: BrushContext, density: number): void {
  const { radius } = context.settings
  for (const entry of entries) {
    if (!entry.weight || !layer.ensureGroup(entry))
      continue
    const missing = targetCount(entry, radius, density) - layer.countWithin(hit.point, radius, entry.asset)
    // A fraction left over is a chance of one more
    let count = Math.floor(missing) + (context.random() < missing % 1
      ? 1
      : 0)
    for (let attempt = 0; count > 0 && attempt < count * 4 + 4; attempt++) {
      const angle = context.random() * Math.PI * 2
      const distance = Math.sqrt(context.random()) * radius
      const point = hit.point.clone().add(new Vector3(Math.cos(angle) * distance, 0, Math.sin(angle) * distance))
      const below = context.surfaceBelow(point)
      if (below && placeEntry(layer, entry, below, context.random))
        count--
    }
  }
}

/** A stroke that changes the scatter layer, undone by putting back its instances */
function scatterStroke(layer: ScatterLayer, stamp: (hit: BrushHit, context: BrushContext) => void): BrushStroke {
  const before = layer.snapshot()
  const count = (groups: typeof before) => groups.reduce((n, g) => n + g.instances.length, 0)
  return {
    stamp,
    frame: () => layer.flush(),
    end() {
      const after = layer.snapshot()
      layer.commit()
      if (count(before) === count(after) && before.length === after.length)
        return
      return {
        undo: () => layer.restore(before),
        redo: () => layer.restore(after),
      }
    },
  }
}

function eraseStamp(layer: ScatterLayer, hit: BrushHit, context: BrushContext): void {
  const entries = context.scatterBrush?.entries ?? []
  const assets = context.options.ownOnly !== false && entries.length
    ? new Set(entries.map(e => e.asset))
    : undefined
  layer.removeWithin(hit.point, context.settings.radius, assets, Math.min(1, context.settings.strength * 0.5 + 0.05), context.random)
}

function needsEntries(context: BrushContext): boolean {
  if (context.scatterBrush?.entries.length)
    return true
  context.logger?.warn('Pick or make a scatter brush with at least one asset first')
  return false
}

const scatterPaint: BrushDefinition = {
  name: 'scatter.paint',
  label: 'Paint',
  group: 'Scatter',
  icon: ICONS.scatter,
  description: 'Paint the scatter brush\'s assets up to their density. Shift erases',
  target: 'surface',
  color: SCATTER,
  uses: { scatterBrush: true },
  options: [
    {
      type: 'slider',
      key: 'density',
      label: 'paint density',
      min: 0,
      max: 1,
      step: 0.01,
      default: 1,
    },
  ],
  begin(_hit, context) {
    if (!context.invert && !needsEntries(context))
      return undefined
    const layer = context.scatterLayer(true)
    return layer && scatterStroke(layer, (hit, ctx) => ctx.invert
      ? eraseStamp(layer, hit, ctx)
      : scatterDisc(layer, ctx.scatterBrush?.entries ?? [], hit, ctx, Number(ctx.options.density ?? 1)))
  },
}

const scatterErase: BrushDefinition = {
  name: 'scatter.erase',
  label: 'Erase',
  group: 'Scatter',
  icon: ICONS.erase,
  description: 'Remove painted assets under the brush',
  target: 'surface',
  color: SCATTER,
  uses: { scatterBrush: true },
  options: [
    {
      type: 'checkbox',
      key: 'ownOnly',
      label: 'only this brush\'s assets',
      default: true,
    },
  ],
  begin(_hit, context) {
    const layer = context.scatterLayer()
    return layer && scatterStroke(layer, (hit, ctx) => eraseStamp(layer, hit, ctx))
  },
}

const scatterSingle: BrushDefinition = {
  name: 'scatter.single',
  label: 'Single',
  group: 'Scatter',
  icon: ICONS.single,
  description: 'Place one asset where you click',
  target: 'surface',
  color: SCATTER,
  uses: { scatterBrush: true },
  begin(hit, context) {
    if (!needsEntries(context))
      return undefined
    const layer = context.scatterLayer(true)
    if (!layer)
      return undefined
    let placed = false
    return scatterStroke(layer, (at, ctx) => {
      if (placed)
        return
      const entry = pickEntry(ctx.scatterBrush?.entries ?? [], ctx.random)
      placed = !!entry && placeEntry(layer, entry, at, ctx.random)
    })
  },
}

let registered = false

export function registerBuiltinBrushes(): void {
  if (registered)
    return
  registered = true
  for (const brush of [
    sculptBrush('raise', 'Raise', 'Raise the ground. Shift lowers'),
    sculptBrush('lower', 'Lower', 'Lower the ground. Shift raises'),
    sculptBrush('smooth', 'Smooth', 'Even out bumps'),
    sculptBrush('flatten', 'Flatten', 'Level to the height where the stroke started'),
    sculptBrush('noise', 'Noise', 'Add random bumps'),
    paintBrush('paint', 'Paint', 'Paint the selected layer. Shift erases it'),
    paintBrush('erase', 'Erase', 'Take the selected layer away, the others fill in'),
    paintBrush('smooth', 'Blend', 'Soften the edges between layers'),
    scatterPaint,
    scatterErase,
    scatterSingle,
  ])
    registerBrush(brush)
}
