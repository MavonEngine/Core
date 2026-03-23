import type { ContainerApi } from '@tweakpane/core'
import type { Object3D } from 'three'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Mesh, PlaneGeometry } from 'three'
import { Pane } from 'tweakpane'
import EditorHelper from '@mavonengine/core/Editor/EditorHelper'
import styles from './PropertiesPanel.module.css'

interface PrefabPaneConfig {
  label: string
  addBindings(folder: ContainerApi): void
}

/* ── drag-to-adjust input (like Tweakpane scrubbing) ── */

function DraggableInput({ value, onChange, speed, className }: { value: number, onChange(v: number): void, speed?: number, className?: string }) {
  const inputRef = useRef<HTMLInputElement>(null)
  const dragState = useRef<{ startX: number, startVal: number, dragged: boolean } | null>(null)
  const fmt = (n: number) => Number.parseFloat(n.toFixed(2)).toString()
  const s = speed ?? 0.01

  const onPointerDown = (e: React.PointerEvent<HTMLInputElement>) => {
    if (document.activeElement === inputRef.current)
      return
    e.preventDefault()
    dragState.current = { startX: e.clientX, startVal: value, dragged: false }

    const onMove = (ev: PointerEvent) => {
      if (!dragState.current)
        return
      const dx = ev.clientX - dragState.current.startX
      if (Math.abs(dx) > 2)
        dragState.current.dragged = true
      if (dragState.current.dragged) {
        const newVal = dragState.current.startVal + dx * s
        onChange(Number.parseFloat(newVal.toFixed(4)))
      }
    }
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
      if (!dragState.current?.dragged) {
        inputRef.current?.focus()
        inputRef.current?.select()
      }
      dragState.current = null
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const commit = (raw: string) => {
    const v = Number.parseFloat(raw)
    if (!Number.isNaN(v))
      onChange(v)
  }

  return (
    <input
      ref={inputRef}
      className={className}
      defaultValue={fmt(value)}
      key={fmt(value)}
      onPointerDown={onPointerDown}
      onBlur={e => commit(e.target.value)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter') {
          commit((e.target as HTMLInputElement).value);
          (e.target as HTMLInputElement).blur()
        }
      }}
      onKeyUp={e => e.stopPropagation()}
    />
  )
}

/* ── tiny reusable pieces ─────────────────────────── */

function SectionHeader({ title, expanded, onToggle }: { title: string, expanded: boolean, onToggle(): void }) {
  return (
    <div className={styles.sectionHeader} onClick={onToggle}>
      <svg className={`${styles.sectionArrow} ${expanded ? '' : styles.collapsed}`} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M6 9l6 6 6-6" />
      </svg>
      <span className={styles.sectionTitle}>{title}</span>
    </div>
  )
}

function Vec3Row({ label, x, y, z, onChange }: { label: string, x: number, y: number, z: number, onChange(axis: 'x' | 'y' | 'z', v: number): void }) {
  return (
    <div className={styles.propertyRow3}>
      <span className={styles.propertyLabel}>{label}</span>
      <DraggableInput className={styles.draggableInput} value={x} onChange={v => onChange('x', v)} />
      <DraggableInput className={styles.draggableInput} value={y} onChange={v => onChange('y', v)} />
      <DraggableInput className={styles.draggableInput} value={z} onChange={v => onChange('z', v)} />
    </div>
  )
}

function CheckboxRow({ label, checked, onChange }: { label: string, checked: boolean, onChange(v: boolean): void }) {
  const id = `cb-${label}`
  return (
    <div className={styles.checkboxRow}>
      <input id={id} type="checkbox" className={styles.checkbox} checked={checked} onChange={e => onChange(e.target.checked)} />
      <label htmlFor={id} className={styles.checkboxLabel}>{label}</label>
    </div>
  )
}

function ColorRow({ label, value, onChange }: { label: string, value: string, onChange(v: string): void }) {
  return (
    <div className={styles.propertyRow}>
      <span className={styles.propertyLabelWide}>{label}</span>
      <input
        type="color"
        className={styles.colorInput}
        defaultValue={value}
        key={value}
        onChange={e => onChange(e.target.value)}
      />
    </div>
  )
}

function ReadonlyRow({ label, value }: { label: string, value: string }) {
  return (
    <div className={styles.propertyRow}>
      <span className={styles.propertyLabelWide}>{label}</span>
      <span className={styles.valueDisplay}>{value}</span>
    </div>
  )
}

function SliderRow({ label, value, min, max, step, onChange }: { label: string, value: number, min: number, max: number, step?: number, onChange(v: number): void }) {
  const trackRef = useRef<HTMLDivElement>(null)
  const s = step ?? 1

  const clamp = (v: number) => Math.round(Math.min(max, Math.max(min, v)) / s) * s
  const pct = ((clamp(value) - min) / (max - min)) * 100

  const valueFromMouse = (clientX: number) => {
    const rect = trackRef.current!.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    return clamp(min + ratio * (max - min))
  }

  const onPointerDown = (e: React.PointerEvent) => {
    e.preventDefault()
    const newVal = valueFromMouse(e.clientX)
    onChange(newVal)

    const onMove = (ev: PointerEvent) => onChange(valueFromMouse(ev.clientX))
    const onUp = () => {
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', onUp)
    }
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', onUp)
  }

  const handleInput = (raw: string) => {
    const v = Number.parseFloat(raw)
    if (!Number.isNaN(v))
      onChange(clamp(v))
  }

  return (
    <div className={styles.sliderRow}>
      <span className={styles.propertyLabelWide}>{label}</span>
      <div className={styles.sliderTrack} ref={trackRef} onPointerDown={onPointerDown}>
        <div className={styles.sliderFill} style={{ width: `${pct}%` }} />
        <div className={styles.sliderThumb} style={{ left: `${pct}%` }} />
      </div>
      <input
        className={styles.sliderInput}
        defaultValue={String(clamp(value))}
        key={`${label}-${clamp(value)}`}
        onBlur={e => handleInput(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation()
          if (e.key === 'Enter')
            handleInput((e.target as HTMLInputElement).value)
        }}
        onKeyUp={e => e.stopPropagation()}
      />
    </div>
  )
}

/* ── Prefab pane (still uses tweakpane for addon-contributed UI) ── */

function PrefabPane({ config }: { config: PrefabPaneConfig }) {
  const containerRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!containerRef.current)
      return
    const pane = new Pane({ container: containerRef.current, title: config.label })
    config.addBindings(pane)
    return () => pane.dispose()
  }, [config])

  return <div className={styles.prefabSection} ref={containerRef} />
}

/* ── Main panel ───────────────────────────────────── */

export default function PropertiesPanel() {
  const [object, setObject] = useState<Object3D | null>(null)
  const [, forceUpdate] = useState(0)
  const [prefabPanes, setPrefabPanes] = useState<Map<string, PrefabPaneConfig>>(new Map())

  const tick = useCallback(() => forceUpdate(n => n + 1), [])

  /* section collapse state */
  const [expandTransform, setExpandTransform] = useState(true)
  const [expandInfo, setExpandInfo] = useState(true)
  const [expandMaterial, setExpandMaterial] = useState(true)
  const [expandGeometry, setExpandGeometry] = useState(true)
  const [expandLight, setExpandLight] = useState(true)

  /* listen for selection */
  useEffect(() => {
    function onObjectSelected(selected: Object3D) {
      setObject(prev => prev?.uuid !== selected.uuid ? selected : prev)
    }
    function onObjectDeselected() {
      setObject(null)
    }
    window.Game.editor?.on('objectSelected', onObjectSelected)
    window.Game.editor?.on('objectDeselected', onObjectDeselected)
    return () => {
      window.Game.editor?.off('objectSelected', onObjectSelected)
      window.Game.editor?.off('objectDeselected', onObjectDeselected)
    }
  }, [])

  /* listen for prefab panes */
  useEffect(() => {
    function onPrefabCreated(config: PrefabPaneConfig) {
      setPrefabPanes(prev => prev.has(config.label) ? prev : new Map(prev).set(config.label, config))
    }
    function onPrefabPanesCleared() {
      setPrefabPanes(new Map())
    }
    window.Game.editor?.on('prefabCreated', onPrefabCreated)
    window.Game.editor?.on('prefabPanesCleared', onPrefabPanesCleared)
    return () => {
      window.Game.editor?.off('prefabCreated', onPrefabCreated)
      window.Game.editor?.off('prefabPanesCleared', onPrefabPanesCleared)
    }
  }, [])

  /* poll for live updates (e.g. dragging gizmos) — only re-render when transform actually changed */
  const prevTransformRef = useRef('')
  useEffect(() => {
    if (!object)
      return
    prevTransformRef.current = ''
    const id = setInterval(() => {
      const key = `${object.position.x},${object.position.y},${object.position.z},${object.rotation.x},${object.rotation.y},${object.rotation.z},${object.scale.x},${object.scale.y},${object.scale.z}`
      if (key !== prevTransformRef.current) {
        prevTransformRef.current = key
        tick()
      }
    }, 200)
    return () => clearInterval(id)
  }, [object, tick])

  if (!object) {
    return <div className={styles.empty}>Select an object</div>
  }

  const isMesh = object instanceof Mesh
  const materials = isMesh ? (Array.isArray(object.material) ? object.material : [object.material]) : []
  const isPlane = isMesh && object.geometry instanceof PlaneGeometry
  const helperProperties = EditorHelper.from(object)?.attachment?.properties ?? null

  return (
    <div className={styles.container}>
      {/* Name row */}
      <div className={styles.nameRow}>
        <svg className={styles.nameIcon} viewBox="0 0 24 24" fill="none" stroke="var(--accent-blue)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" />
        </svg>
        <span className={styles.nameText}>{object.name || 'Object3D'}</span>
      </div>

      {/* Transform */}
      <SectionHeader title="Transform" expanded={expandTransform} onToggle={() => setExpandTransform(v => !v)} />
      {expandTransform && (
        <>
          <Vec3Row
            label="Position"
            x={object.position.x}
            y={object.position.y}
            z={object.position.z}
            onChange={(axis, v) => {
              object.position[axis] = v
              tick()
            }}
          />
          <Vec3Row
            label="Rotation"
            x={object.rotation.x}
            y={object.rotation.y}
            z={object.rotation.z}
            onChange={(axis, v) => {
              object.rotation[axis] = v
              tick()
            }}
          />
          <Vec3Row
            label="Scale"
            x={object.scale.x}
            y={object.scale.y}
            z={object.scale.z}
            onChange={(axis, v) => {
              object.scale[axis] = v
              tick()
            }}
          />
        </>
      )}

      <div className={styles.divider} />

      {/* Info */}
      <SectionHeader title="Info" expanded={expandInfo} onToggle={() => setExpandInfo(v => !v)} />
      {expandInfo && (
        <>
          <CheckboxRow
            label="visible"
            checked={object.visible}
            onChange={(v) => {
              object.visible = v
              tick()
            }}
          />
          <CheckboxRow
            label="castShadow"
            checked={object.castShadow}
            onChange={(v) => {
              object.castShadow = v
              tick()
            }}
          />
          <CheckboxRow
            label="receiveShadow"
            checked={object.receiveShadow}
            onChange={(v) => {
              object.receiveShadow = v
              tick()
            }}
          />
          <ReadonlyRow label="uuid" value={object.uuid} />
        </>
      )}

      {/* Material (mesh only) */}
      {isMesh && (
        <>
          <div className={styles.divider} />
          <SectionHeader title="Material" expanded={expandMaterial} onToggle={() => setExpandMaterial(v => !v)} />
          {expandMaterial && (
            <CheckboxRow
              label="wireframe"
              checked={(materials[0] as { wireframe?: boolean }).wireframe ?? false}
              onChange={(v) => {
                materials.forEach((m) => {
                  (m as { wireframe?: boolean, needsUpdate: boolean }).wireframe = v
                  m.needsUpdate = true
                })
                tick()
              }}
            />
          )}
        </>
      )}

      {/* Geometry (plane only) */}
      {isPlane && (
        <>
          <div className={styles.divider} />
          <SectionHeader title="Geometry" expanded={expandGeometry} onToggle={() => setExpandGeometry(v => !v)} />
          {expandGeometry && (
            <>
              <SliderRow
                label="Width"
                min={0.1}
                max={100}
                step={0.1}
                value={(object as Mesh & { geometry: PlaneGeometry }).geometry.parameters.width}
                onChange={(v) => {
                  const mesh = object as Mesh & { geometry: PlaneGeometry }
                  const { height, widthSegments, heightSegments } = mesh.geometry.parameters
                  mesh.geometry.dispose()
                  mesh.geometry = new PlaneGeometry(v, height, widthSegments, heightSegments)
                  tick()
                }}
              />
              <SliderRow
                label="W Segments"
                min={1}
                max={128}
                step={1}
                value={(object as Mesh & { geometry: PlaneGeometry }).geometry.parameters.widthSegments}
                onChange={(v) => {
                  const mesh = object as Mesh & { geometry: PlaneGeometry }
                  const { width, height, heightSegments } = mesh.geometry.parameters
                  mesh.geometry.dispose()
                  mesh.geometry = new PlaneGeometry(width, height, v, heightSegments)
                  tick()
                }}
              />
              <SliderRow
                label="Height"
                min={0.1}
                max={100}
                step={0.1}
                value={(object as Mesh & { geometry: PlaneGeometry }).geometry.parameters.height}
                onChange={(v) => {
                  const mesh = object as Mesh & { geometry: PlaneGeometry }
                  const { width, widthSegments, heightSegments } = mesh.geometry.parameters
                  mesh.geometry.dispose()
                  mesh.geometry = new PlaneGeometry(width, v, widthSegments, heightSegments)
                  tick()
                }}
              />
              <SliderRow
                label="H Segments"
                min={1}
                max={128}
                step={1}
                value={(object as Mesh & { geometry: PlaneGeometry }).geometry.parameters.heightSegments}
                onChange={(v) => {
                  const mesh = object as Mesh & { geometry: PlaneGeometry }
                  const { width, height, widthSegments } = mesh.geometry.parameters
                  mesh.geometry.dispose()
                  mesh.geometry = new PlaneGeometry(width, height, widthSegments, v)
                  tick()
                }}
              />
            </>
          )}
        </>
      )}

      {/* Helper properties (e.g. lights) */}
      {helperProperties && (
        <>
          <div className={styles.divider} />
          <SectionHeader title="Properties" expanded={expandLight} onToggle={() => setExpandLight(v => !v)} />
          {expandLight && helperProperties.map((field) => {
            if (field.type === 'color') {
              return (
                <ColorRow
                  key={field.label}
                  label={field.label}
                  value={field.getValue()}
                  onChange={(v) => {
                    field.setValue(v)
                    tick()
                  }}
                />
              )
            }
            if (field.type === 'slider') {
              return (
                <SliderRow
                  key={field.label}
                  label={field.label}
                  min={field.min}
                  max={field.max}
                  step={field.step}
                  value={field.getValue()}
                  onChange={(v) => {
                    field.setValue(v)
                    tick()
                  }}
                />
              )
            }
            if (field.type === 'checkbox') {
              return (
                <CheckboxRow
                  key={field.label}
                  label={field.label}
                  checked={field.getValue()}
                  onChange={(v) => {
                    field.setValue(v)
                    tick()
                  }}
                />
              )
            }
            return null
          })}
        </>
      )}

      {/* Prefab panes (still use tweakpane for addon-contributed UI) */}
      {[...prefabPanes.values()].map(config => <PrefabPane key={config.label} config={config} />)}
    </div>
  )
}
