import type { BrushDefinition, BrushOption } from '@mavonengine/core/Brushes/BrushRegistry'
import type { ScaleMode, ScatterBrush, ScatterBrushEntry } from '@mavonengine/core/Scatter/scatterBrush'
import type { ScatterColliderShape } from '@mavonengine/core/Scatter/scatterData'
import type Terrain from '@mavonengine/core/Terrain/Terrain'
import type { ReactNode } from 'react'
import type { ListedScatterBrush } from '../../Brushes/brushFiles'
import type BrushTool from '../../Brushes/BrushTool'
import { getBrushes, subscribeBrushes } from '@mavonengine/core/Brushes/BrushRegistry'
import { materialGraphs } from '@mavonengine/core/Graph/Material/MaterialGraphs'
import { BRUSH_NAME_RE, defaultBrushEntry } from '@mavonengine/core/Scatter/scatterBrush'
import { instanceCount } from '@mavonengine/core/Scatter/scatterData'
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react'
import { deleteScatterBrush, fetchScatterBrushes, saveScatterBrush } from '../../Brushes/brushFiles'
import styles from './BrushesPanel.module.css'

/* ── hooks ─────────────────────────────────────────── */

function useBrushTool(): BrushTool | undefined {
  const tool = (window.Game.editor as { brushes?: BrushTool } | undefined)?.brushes
  const subscribe = useCallback((listener: () => void) => {
    tool?.on('changed', listener)
    window.Game.editor?.on('sceneChanged', listener)
    window.Game.editor?.on('objectSelected', listener)
    return () => {
      tool?.off('changed', listener)
      window.Game.editor?.off('sceneChanged', listener)
      window.Game.editor?.off('objectSelected', listener)
    }
  }, [tool])
  useSyncExternalStore(subscribe, () => `${tool?.version}:${window.Game.activeScene?.getEntries().length}:${tool?.terrain()?.id}`)
  return tool
}

// A new array only when the brushes change, as useSyncExternalStore needs
let brushesSnapshot = getBrushes()
subscribeBrushes(() => {
  brushesSnapshot = getBrushes()
})
function useBrushes() {
  return useSyncExternalStore(subscribeBrushes, () => brushesSnapshot)
}

function useMaterialGraphs() {
  const [, setVersion] = useState(0)
  useEffect(() => {
    void materialGraphs.refreshList()
    return materialGraphs.subscribe(() => setVersion(v => v + 1))
  }, [])
  return materialGraphs.list.filter(graph => graph.kind === 'material' && !graph.function)
}

/** The gltf models among the loaded resources, by resource name */
function modelNames(): string[] {
  return Object.entries(window.Game.resources.items)
    .filter(([, item]) => !!item && typeof item === 'object' && 'scene' in item)
    .map(([name]) => name)
    .sort()
}

/* ── small inputs ──────────────────────────────────── */

function Row({ label, children }: { label: string, children: ReactNode }) {
  return (
    <label className={styles.row}>
      <span className={styles.label}>{label}</span>
      {children}
    </label>
  )
}

function NumberInput({ value, onChange, step = 0.1, min, max }: { value: number, onChange(v: number): void, step?: number, min?: number, max?: number }) {
  return (
    <input
      className={styles.number}
      type="number"
      step={step}
      min={min}
      max={max}
      defaultValue={value}
      key={value}
      onBlur={(e) => {
        const v = Number.parseFloat(e.target.value)
        if (!Number.isNaN(v))
          onChange(v)
      }}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter')
          (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

function Slider({ label, value, min, max, step, onChange }: { label: string, value: number, min: number, max: number, step: number, onChange(v: number): void }) {
  return (
    <Row label={label}>
      <input className={styles.slider} type="range" min={min} max={max} step={step} value={value} onChange={e => onChange(Number(e.target.value))} />
      <NumberInput value={value} step={step} min={min} max={max} onChange={onChange} />
    </Row>
  )
}

function RangeRow({ label, value, step, onChange }: { label: string, value: [number, number], step?: number, onChange(v: [number, number]): void }) {
  return (
    <Row label={label}>
      <NumberInput value={value[0]} step={step} onChange={v => onChange([v, value[1]])} />
      <span className={styles.dash}>–</span>
      <NumberInput value={value[1]} step={step} onChange={v => onChange([value[0], v])} />
    </Row>
  )
}

function Check({ label, checked, onChange }: { label: string, checked: boolean, onChange(v: boolean): void }) {
  return (
    <label className={styles.check}>
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {label}
    </label>
  )
}

function Section({ title, children, actions }: { title: string, children: ReactNode, actions?: ReactNode }) {
  return (
    <div className={styles.section}>
      <div className={styles.sectionHeader}>
        <span>{title}</span>
        {actions}
      </div>
      {children}
    </div>
  )
}

function Icon({ paths }: { paths?: string[] }) {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {(paths ?? ['M12 12a6 6 0 1 0 0-.1']).map((d, i) => <path key={i} d={d} />)}
    </svg>
  )
}

/* ── brush options ─────────────────────────────────── */

function OptionField({ option, value, onChange }: { option: BrushOption, value: unknown, onChange(v: unknown): void }) {
  switch (option.type) {
    case 'slider':
      return <Slider label={option.label} value={Number(value ?? option.default)} min={option.min} max={option.max} step={option.step} onChange={onChange} />
    case 'checkbox':
      return <Check label={option.label} checked={Boolean(value ?? option.default)} onChange={onChange} />
    case 'select':
      return (
        <Row label={option.label}>
          <select className={styles.select} value={String(value ?? option.default)} onChange={e => onChange(e.target.value)}>
            {option.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        </Row>
      )
  }
}

/* ── terrain layers ────────────────────────────────── */

function TerrainLayers({ tool, terrain }: { tool: BrushTool, terrain: Terrain }) {
  const graphs = useMaterialGraphs()
  const layers = terrain.layers
  const active = Math.min(tool.settings.paintLayer, Math.max(0, layers.length - 1))
  const changed = () => {
    tool.sceneChanged()
    tool.setSettings({})
  }

  const fill = () => {
    const before = terrain.splat.maps.map(m => m.slice())
    terrain.splat.fill(active)
    terrain.splatChanged()
    const after = terrain.splat.maps.map(m => m.slice())
    const put = (maps: Uint8Array[]) => {
      maps.forEach((m, i) => terrain.splat.maps[i]?.set(m))
      terrain.splatChanged()
    }
    tool.pushUndo('Fill', {
      undo: () => put(before),
      redo: () => put(after),
    })
  }

  return (
    <Section
      title="Layers"
      actions={layers.length > 0 && <button className={styles.small} onClick={fill} title="Cover the whole terrain with the selected layer">Fill</button>}
    >
      {layers.map((layer, i) => (
        <div
          key={i}
          className={`${styles.layer}${i === active
            ? ` ${styles.layerActive}`
            : ''}`}
          onClick={() => tool.setSettings({ paintLayer: i })}
        >
          <span className={styles.layerIndex}>{i + 1}</span>
          <select
            className={styles.select}
            value={layer.graph}
            onClick={e => e.stopPropagation()}
            onChange={(e) => {
              terrain.setLayer(i, { graph: e.target.value })
              changed()
            }}
          >
            {[
              ...new Set([
                layer.graph,
                ...graphs.map(g => g.name),
              ]),
            ].map(name => <option key={name} value={name}>{name}</option>)}
          </select>
          <span title="Tiling: times the textures repeat across the terrain">
            <NumberInput
              value={layer.tiling}
              step={1}
              min={0.01}
              onChange={(v) => {
                terrain.setLayer(i, { tiling: v })
                changed()
              }}
            />
          </span>
          <button
            className={styles.icon}
            title="Remove layer"
            onClick={(e) => {
              e.stopPropagation()
              terrain.removeLayer(i)
              changed()
            }}
          >
            ×
          </button>
        </div>
      ))}
      {layers.length < 8 && (
        <select
          className={styles.select}
          value=""
          onChange={(e) => {
            if (!e.target.value)
              return
            terrain.addLayer(e.target.value)
            tool.setSettings({ paintLayer: terrain.layers.length - 1 })
            tool.sceneChanged()
          }}
        >
          <option value="">+ Add layer (material graph)…</option>
          {graphs.map(g => <option key={g.name} value={g.name}>{g.name}</option>)}
        </select>
      )}
      {!layers.length && <p className={styles.hint}>Add a material graph as the first layer. It covers the whole terrain; paint the next ones on top.</p>}
    </Section>
  )
}

/* ── scatter brush editor ──────────────────────────── */

const SHAPES: ScatterColliderShape[] = ['box', 'cylinder', 'sphere', 'none']
const SCALE_MODES: ScaleMode[] = ['uniform', 'free', 'lockXZ']

function EntryEditor({ entry, layerGraphs, readOnly, onChange, onRemove }: {
  entry: ScatterBrushEntry
  layerGraphs: string[]
  readOnly: boolean
  onChange(e: ScatterBrushEntry): void
  onRemove(): void
}) {
  const [open, setOpen] = useState(false)
  const set = (changes: Partial<ScatterBrushEntry>) => onChange({
    ...entry,
    ...changes,
  })
  return (
    <div className={styles.entry}>
      <div className={styles.entryHeader} onClick={() => setOpen(!open)}>
        <span className={styles.arrow}>{open ? '▾' : '▸'}</span>
        <span className={styles.entryName}>{entry.asset}</span>
        <span className={styles.muted}>
          {entry.density}
          /100m²
        </span>
        {!readOnly && (
          <button
            className={styles.icon}
            title="Remove asset"
            onClick={(e) => {
              e.stopPropagation()
              onRemove()
            }}
          >
            ×
          </button>
        )}
      </div>
      {open && (
        <fieldset className={styles.entryBody} disabled={readOnly}>
          <Row label="asset">
            <select className={styles.select} value={entry.asset} onChange={e => set({ asset: e.target.value })}>
              {[
                ...new Set([
                  entry.asset,
                  ...modelNames(),
                ]),
              ].map(name => <option key={name} value={name}>{name}</option>)}
            </select>
          </Row>
          <Row label="weight"><NumberInput value={entry.weight} min={0} onChange={v => set({ weight: v })} /></Row>
          <Row label="density"><NumberInput value={entry.density} min={0} onChange={v => set({ density: v })} /></Row>
          <Row label="spacing (m)"><NumberInput value={entry.minSpacing} min={0} onChange={v => set({ minSpacing: v })} /></Row>
          <Row label="scale">
            <NumberInput
              value={entry.scale.min}
              step={0.05}
              onChange={v => set({
                scale: { ...entry.scale, min: v },
              })}
            />
            <span className={styles.dash}>–</span>
            <NumberInput
              value={entry.scale.max}
              step={0.05}
              onChange={v => set({
                scale: { ...entry.scale, max: v },
              })}
            />
          </Row>
          <Row label="scale mode">
            <select
              className={styles.select}
              value={entry.scale.mode}
              onChange={e => set({
                scale: { ...entry.scale, mode: e.target.value as ScaleMode },
              })}
            >
              {SCALE_MODES.map(m => <option key={m} value={m}>{m}</option>)}
            </select>
          </Row>
          <Check label="random yaw" checked={entry.randomYaw} onChange={v => set({ randomYaw: v })} />
          <Slider label="random pitch °" value={entry.randomPitch} min={0} max={90} step={1} onChange={v => set({ randomPitch: v })} />
          <Slider label="align to normal" value={entry.alignToNormal} min={0} max={1} step={0.05} onChange={v => set({ alignToNormal: v })} />
          <RangeRow label="slope °" value={entry.slope} step={1} onChange={v => set({ slope: v })} />
          <RangeRow label="height (m)" value={entry.height} onChange={v => set({ height: v })} />
          <RangeRow label="z offset (m)" value={entry.zOffset} step={0.05} onChange={v => set({ zOffset: v })} />
          <Row label="only on layer">
            <select
              className={styles.select}
              value={entry.layerFilter?.graph ?? ''}
              onChange={e => set({
                layerFilter: e.target.value
                  ? { graph: e.target.value, minWeight: entry.layerFilter?.minWeight ?? 0.5 }
                  : undefined,
              })}
            >
              <option value="">Any ground</option>
              {[
                ...new Set([
                  ...(entry.layerFilter
                    ? [entry.layerFilter.graph]
                    : []),
                  ...layerGraphs,
                ]),
              ].map(g => <option key={g} value={g}>{g}</option>)}
            </select>
          </Row>
          {entry.layerFilter && (
            <Slider
              label="min. coverage"
              value={entry.layerFilter.minWeight}
              min={0}
              max={1}
              step={0.05}
              onChange={v => set({
                layerFilter: { ...entry.layerFilter!, minWeight: v },
              })}
            />
          )}
          <Check label="collision (multiplayer)" checked={entry.collision} onChange={v => set({ collision: v })} />
          {entry.collision && (
            <Row label="collider">
              <select
                className={styles.select}
                value={entry.collider.shape}
                onChange={e => set({
                  collider: { ...entry.collider, shape: e.target.value as ScatterColliderShape },
                })}
              >
                {SHAPES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
              <span title="Part of the model's bounds the collider fills, e.g. 0.2 for a tree's trunk">
                <NumberInput
                  value={entry.collider.fit}
                  step={0.05}
                  min={0.01}
                  max={2}
                  onChange={v => set({
                    collider: { ...entry.collider, fit: v },
                  })}
                />
              </span>
            </Row>
          )}
          <Check label="cast shadow" checked={entry.castShadow} onChange={v => set({ castShadow: v })} />
          <Check label="receive shadow" checked={entry.receiveShadow} onChange={v => set({ receiveShadow: v })} />
        </fieldset>
      )}
    </div>
  )
}

function ScatterBrushes({ tool }: { tool: BrushTool }) {
  const [brushes, setBrushes] = useState<ListedScatterBrush[]>([])
  const [dirty, setDirty] = useState(false)
  const [error, setError] = useState<string>()
  /** Asking for a name: of a new brush, or of a copy of a plugin's */
  const [naming, setNaming] = useState<{ kind: 'new' | 'copy', name: string }>()
  const [confirmDelete, setConfirmDelete] = useState(false)
  const current = tool.scatterBrush as ListedScatterBrush | undefined
  const readOnly = !!current?.plugin
  const layerGraphs = tool.terrain()?.layers.map(l => l.graph) ?? []

  const reload = useCallback(async (select?: string) => {
    const list = await fetchScatterBrushes()
    setBrushes(list)
    const name = select ?? tool.scatterBrush?.name
    tool.setScatterBrush(list.find(b => b.name === name) ?? tool.scatterBrush ?? list[0])
  }, [tool])

  useEffect(() => {
    void reload()
  }, [reload])

  const edit = (brush: ScatterBrush) => {
    tool.setScatterBrush(brush)
    setDirty(true)
    // What is already painted with these assets follows the brush's settings (shadows, collision) right away
    const layer = tool.scatterLayer()
    if (layer && brush.entries.map(entry => layer.applyEntry(entry)).some(Boolean))
      tool.sceneChanged()
  }

  const save = async (brush = current) => {
    if (!brush)
      return
    try {
      await saveScatterBrush(brush)
      setDirty(false)
      setError(undefined)
      await reload(brush.name)
    }
    catch (err) {
      setError((err as Error).message)
    }
  }

  const finishNaming = () => {
    if (!naming)
      return
    const { kind, name } = naming
    if (!BRUSH_NAME_RE.test(name)) {
      setError(`"${name}" is not a valid name: use letters, digits, - and _`)
      return
    }
    setNaming(undefined)
    if (kind === 'copy' && current) {
      void save({ ...current, name, plugin: undefined } as ScatterBrush)
      return
    }
    const first = modelNames()[0]
    void save({
      version: 1,
      kind: 'scatter',
      name,
      entries: first
        ? [
            defaultBrushEntry(first),
          ]
        : [],
    })
  }

  return (
    <Section
      title="Scatter brush"
      actions={(
        <span className={styles.actions}>
          <button className={styles.small} onClick={() => setNaming({ kind: 'new', name: 'forest' })}>New</button>
          {readOnly && (
            <button
              className={styles.small}
              onClick={() => setNaming({
                kind: 'copy',
                name: current!.name.split(':').pop()!,
              })}
              title="Plugins' brushes are read only: copy it into the project to change it"
            >
              Copy
            </button>
          )}
          {current && !readOnly && <button className={styles.small} disabled={!dirty} onClick={() => void save()}>Save</button>}
          {current && !readOnly && (
            <button
              className={styles.small}
              title={`Delete brushes/${current.name}.brush.json`}
              onBlur={() => setConfirmDelete(false)}
              onClick={() => {
                // A second click deletes
                if (!confirmDelete) {
                  setConfirmDelete(true)
                  return
                }
                setConfirmDelete(false)
                void deleteScatterBrush(current.name).then(() => {
                  tool.setScatterBrush(undefined)
                  return reload()
                })
              }}
            >
              {confirmDelete
                ? 'Sure?'
                : 'Delete'}
            </button>
          )}
        </span>
      )}
    >
      {naming && (
        <div className={styles.row}>
          <input
            className={styles.select}
            autoFocus
            value={naming.name}
            placeholder="brush name"
            onChange={e => setNaming({ ...naming, name: e.target.value })}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter')
                finishNaming()
              if (e.key === 'Escape')
                setNaming(undefined)
            }}
          />
          <button className={styles.small} onClick={finishNaming}>
            {naming.kind === 'new'
              ? 'Create'
              : 'Copy'}
          </button>
          <button className={styles.small} onClick={() => setNaming(undefined)}>Cancel</button>
        </div>
      )}
      <select
        className={styles.select}
        value={current?.name ?? ''}
        onChange={(e) => {
          tool.setScatterBrush(brushes.find(b => b.name === e.target.value))
          setDirty(false)
        }}
      >
        {!current && <option value="">No scatter brush yet</option>}
        {current && !brushes.some(b => b.name === current.name) && (
          <option value={current.name}>
            {current.name}
            {' '}
            (unsaved)
          </option>
        )}
        {brushes.map(b => (
          <option key={b.name} value={b.name}>
            {b.plugin
              ? `${b.name} (plugin)`
              : b.name}
          </option>
        ))}
      </select>
      {error && <p className={styles.error}>{error}</p>}
      {current?.entries.map((entry, i) => (
        <EntryEditor
          key={i}
          entry={entry}
          layerGraphs={layerGraphs}
          readOnly={readOnly}
          onChange={e => edit({
            ...current,
            entries: current.entries.map((old, j) => j === i
              ? e
              : old),
          })}
          onRemove={() => edit({
            ...current,
            entries: current.entries.filter((_, j) => j !== i),
          })}
        />
      ))}
      {current && !readOnly && (
        <select
          className={styles.select}
          value=""
          onChange={e => e.target.value && edit({
            ...current,
            entries: [
              ...current.entries,
              defaultBrushEntry(e.target.value),
            ],
          })}
        >
          <option value="">+ Add asset (model)…</option>
          {modelNames().map(name => <option key={name} value={name}>{name}</option>)}
        </select>
      )}
      {current && !modelNames().length && <p className={styles.hint}>No models are loaded. Import one, e.g. from Poly Haven, to paint it.</p>}
    </Section>
  )
}

function ScatterLayerGroups({ tool }: { tool: BrushTool }) {
  const layer = tool.scatterLayer()
  if (!layer?.groups.length)
    return null
  return (
    <Section title="Painted assets">
      <Check
        label="collision for all"
        checked={layer.props.collision}
        onChange={(v) => {
          layer.setCollision(v)
          tool.sceneChanged()
          tool.setSettings({})
        }}
      />
      {layer.groups.map(group => (
        <div key={group.asset} className={styles.group}>
          <span className={styles.entryName}>{group.asset}</span>
          <span className={styles.muted}>{instanceCount(group)}</span>
          <Check
            label="collides"
            checked={group.collision}
            onChange={(v) => {
              layer.setGroup(group.asset, { collision: v })
              tool.sceneChanged()
              tool.setSettings({})
            }}
          />
        </div>
      ))}
    </Section>
  )
}

/* ── panel ─────────────────────────────────────────── */

export default function BrushesPanel() {
  const tool = useBrushTool()
  const brushes = useBrushes()
  const groups = [
    ...new Set(brushes.map(b => b.group)),
  ]
  const [group, setGroup] = useState(() => tool?.definition?.group ?? groups[0] ?? 'Sculpt')

  // Follow the brush in use, also when it was picked elsewhere (a shortcut, a plugin)
  const activeGroup = tool?.definition?.group
  useEffect(() => {
    if (activeGroup)
      setGroup(activeGroup)
  }, [activeGroup])

  if (!tool)
    return <p className={styles.hint}>The editor is starting…</p>

  const definition = tool.definition
  const inGroup = brushes.filter(b => b.group === group)
  const needsTerrain = inGroup.some(b => b.target === 'terrain') || inGroup.some(b => b.uses?.layers)
  const terrain = tool.terrain()
  const s = tool.settings
  const pick = (brush: BrushDefinition & { key: string }) => tool.setBrush(tool.brush === brush.key
    ? null
    : brush.key)

  return (
    <div className={styles.panel}>
      <div className={styles.tabs}>
        {groups.map(g => (
          <button
            key={g}
            className={`${styles.tab}${g === group
              ? ` ${styles.tabActive}`
              : ''}`}
            onClick={() => setGroup(g)}
          >
            {g}
          </button>
        ))}
      </div>

      <div className={styles.brushes}>
        {inGroup.map(brush => (
          <button
            key={brush.key}
            title={`${brush.description ?? brush.label ?? brush.name}${brush.plugin
              ? ` (${brush.plugin})`
              : ''}`}
            className={`${styles.brush}${tool.brush === brush.key
              ? ` ${styles.brushActive}`
              : ''}`}
            onClick={() => pick(brush)}
          >
            <Icon paths={brush.icon} />
            <span>{brush.label ?? brush.name}</span>
          </button>
        ))}
      </div>
      <p className={styles.hint}>
        {definition
          ? 'Drag to paint · Shift: opposite · [ ] size · Ctrl+Z undo · Esc stop'
          : 'Pick a brush to paint. Select objects again with Esc or by clicking the brush once more.'}
      </p>

      {needsTerrain && !terrain && (
        <Section title="Terrain">
          <p className={styles.hint}>These brushes work on a terrain. The scene has none yet.</p>
          <button className={styles.button} onClick={() => tool.createTerrain()}>Create terrain</button>
        </Section>
      )}

      <Section
        title="Brush"
        actions={(
          <span className={styles.actions}>
            <button className={styles.small} disabled={!tool.canUndo} onClick={() => tool.undo()} title="Undo stroke (Ctrl+Z)">Undo</button>
            <button className={styles.small} disabled={!tool.canRedo} onClick={() => tool.redo()} title="Redo stroke (Ctrl+Shift+Z)">Redo</button>
          </span>
        )}
      >
        <Slider label="size (m)" value={s.radius} min={0.1} max={100} step={0.1} onChange={v => tool.setSettings({ radius: v })} />
        <Slider label="strength" value={s.strength} min={0} max={1} step={0.01} onChange={v => tool.setSettings({ strength: v })} />
        <Slider label="falloff" value={s.falloff} min={0} max={1} step={0.01} onChange={v => tool.setSettings({ falloff: v })} />
        <Slider label="spacing" value={s.spacing} min={0.05} max={2} step={0.05} onChange={v => tool.setSettings({ spacing: v })} />
        {definition?.options?.map(option => (
          <OptionField
            key={option.key}
            option={option}
            value={tool.options(tool.brush!)[option.key]}
            onChange={v => tool.setOption(tool.brush!, option.key, v)}
          />
        ))}
      </Section>

      {terrain && (definition?.uses?.layers || (!definition && group === 'Paint')) && <TerrainLayers tool={tool} terrain={terrain} />}
      {(definition?.uses?.scatterBrush || (!definition && group === 'Scatter')) && (
        <>
          <ScatterBrushes tool={tool} />
          <ScatterLayerGroups tool={tool} />
        </>
      )}
    </div>
  )
}
