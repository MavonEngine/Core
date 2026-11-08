import type GameScene from '@mavonengine/core/Scene/GameScene'
import type { SceneEntry } from '@mavonengine/core/Scene/GameScene'
import type GameObject from '@mavonengine/core/World/GameObject'
import { getSceneObject } from '@mavonengine/core/Scene/SceneObjectRegistry'
import { useEffect, useReducer, useState } from 'react'
import { Object3D } from 'three'
import styles from './ScenePanel.module.css'

/** The Object3D the editor selects for a game object: its instance, or its editor helper's gizmo */
function selectable(object: GameObject | undefined): Object3D | undefined {
  if (!object)
    return undefined
  const { instance, editorHelper } = object as { instance?: unknown, editorHelper?: { mesh: Object3D } }
  if (instance instanceof Object3D)
    return instance
  return editorHelper?.mesh
}

function typeLabel(type: string) {
  return getSceneObject(type)?.label ?? type
}

/** Re-render on scene and editor events, and twice a second for what the server sends */
function useSceneRefresh(): GameScene | undefined {
  const [, refresh] = useReducer((n: number) => n + 1, 0)

  useEffect(() => {
    const editor = window.Game.editor
    const events = ['sceneChanged', 'sceneSaved', 'sceneSaving', 'sceneSaveFailed', 'objectSelected', 'objectDeselected', 'assetDropped']
    events.forEach(event => editor?.on(event, refresh))
    const timer = setInterval(refresh, 500)
    return () => {
      events.forEach(event => editor?.off(event, refresh))
      clearInterval(timer)
    }
  }, [])

  return window.Game.activeScene
}

export default function ScenePanel() {
  const scene = useSceneRefresh()
  const [saveState, setSaveState] = useState<{ saving?: boolean, error?: string }>({})
  const [expanded, setExpanded] = useState<string | null>(null)

  useEffect(() => {
    const editor = window.Game.editor
    const saving = () => setSaveState({ saving: true })
    const saved = () => setSaveState({})
    const failed = ({ error }: { error: string }) => setSaveState({ error })
    editor?.on('sceneSaving', saving)
    editor?.on('sceneSaved', saved)
    editor?.on('sceneSaveFailed', failed)
    return () => {
      editor?.off('sceneSaving', saving)
      editor?.off('sceneSaved', saved)
      editor?.off('sceneSaveFailed', failed)
    }
  }, [])

  if (!scene)
    return <div className={styles.empty}>No scene loaded</div>

  const entries = scene.getEntries().filter(entry => !entry.object?.garbageCollect)
  const sceneObjects = new Set(entries.map(entry => entry.object).filter(Boolean))
  const live = [...window.Game.world.entities.items].filter(([, object]) => !sceneObjects.has(object) && !object.garbageCollect)
  const dirty = scene.isDirty()
  const activeItem = window.Game.editor && 'activeItem' in window.Game.editor ? window.Game.editor.activeItem as Object3D | null : null
  const selectedId = scene.entryOfObject3D(activeItem)?.data.id

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.title}>
          <span className={styles.sceneName}>{scene.name}</span>
          {dirty && <span className={styles.dirty} title="Unsaved changes">●</span>}
          <span className={styles.file}>{`scenes/${scene.source ?? 'main'}.json`}</span>
        </div>
        <button
          className={styles.saveButton}
          disabled={saveState.saving}
          title="Save scene (Ctrl+S)"
          onClick={() => void window.Game.editor?.saveScene()}
        >
          {saveState.saving ? 'Saving…' : 'Save'}
        </button>
      </div>
      {saveState.error && <div className={styles.error}>{saveState.error}</div>}

      <SceneSettings scene={scene} />

      <div className={styles.section}>
        {`Scene objects (${entries.length})`}
      </div>
      {entries.map(entry => (
        <SceneRow
          key={entry.data.id}
          scene={scene}
          entry={entry}
          selected={entry.data.id === selectedId}
          expanded={expanded === entry.data.id}
          onToggle={() => setExpanded(expanded === entry.data.id ? null : entry.data.id)}
        />
      ))}

      <div className={styles.section} title="Not part of the scene file: players and what the server spawns. Never saved.">
        {`Live, not saved (${live.length})`}
      </div>
      {live.length === 0 && <div className={styles.hint}>Nothing from the game or server</div>}
      {live.map(([id, object]) => {
        const target = selectable(object)
        const typeName = (object as { $typeName?: string }).$typeName ?? object.constructor.name
        return (
          <div
            key={id}
            className={`${styles.row} ${styles.liveRow} ${target && target === activeItem ? styles.selected : ''}`}
            onClick={() => target && window.Game.editor?.selectObject(target)}
            title={target ? 'Select' : 'Has no object to select'}
          >
            <span className={styles.liveDot} />
            <span className={styles.name}>{id}</span>
            <span className={styles.type}>{typeName}</span>
          </div>
        )
      })}
    </div>
  )
}

function SceneRow({ scene, entry, selected, expanded, onToggle }: { scene: GameScene, entry: SceneEntry, selected: boolean, expanded: boolean, onToggle(): void }) {
  const target = selectable(entry.object)
  const builtHere = !!entry.object

  return (
    <>
      <div
        className={`${styles.row} ${selected ? styles.selected : ''}`}
        onClick={() => (target ? window.Game.editor?.selectObject(target) : onToggle())}
      >
        <span
          className={styles.arrow}
          onClick={(e) => {
            e.stopPropagation()
            onToggle()
          }}
        >
          {expanded ? '▾' : '▸'}
        </span>
        <span className={styles.name}>{entry.data.name ?? entry.data.id}</span>
        <span className={styles.type}>{typeLabel(entry.data.type)}</span>
        {!builtHere && (
          <span className={styles.badge} title="Not built in the client: only the server builds it, e.g. from what it sends. Its props can be edited here.">
            server
          </span>
        )}
      </div>
      {expanded && <EntryDetails scene={scene} entry={entry} />}
    </>
  )
}

/** The id, name, and the props of objects that aren't built here (others are edited in Properties) */
function EntryDetails({ scene, entry }: { scene: GameScene, entry: SceneEntry }) {
  const props = entry.data.props ?? {}
  const [x, y, z] = entry.data.transform.position

  return (
    <div className={styles.details}>
      <label className={styles.field}>
        <span>id</span>
        <code>{entry.data.id}</code>
      </label>
      <label className={styles.field}>
        <span>name</span>
        <input
          defaultValue={entry.data.name ?? ''}
          placeholder={entry.data.id}
          onKeyDown={e => e.stopPropagation()}
          onBlur={e => scene.setName(entry.data.id, e.target.value.trim())}
        />
      </label>
      <label className={styles.field}>
        <span>type</span>
        <code>{entry.data.type}</code>
      </label>
      {!entry.object && (
        <>
          <label className={styles.field}>
            <span>position</span>
            <code>{[x, y, z].map(n => Number(n.toFixed(2))).join(', ')}</code>
          </label>
          {Object.entries(props).map(([key, value]) => (
            <PropField key={key} name={key} value={value} onChange={v => scene.setProps(entry.data.id, { [key]: v })} />
          ))}
          {Object.keys(props).length === 0 && <div className={styles.hint}>No props</div>}
        </>
      )}
      <button className={styles.removeButton} onClick={() => scene.remove(entry.data.id)}>Remove from scene</button>
    </div>
  )
}

function PropField({ name, value, onChange }: { name: string, value: unknown, onChange(value: unknown): void }) {
  const stop = (e: React.KeyboardEvent) => e.stopPropagation()

  let input
  if (typeof value === 'boolean') {
    input = <input type="checkbox" checked={value} onChange={e => onChange(e.target.checked)} />
  }
  else if (typeof value === 'number') {
    input = (
      <input
        type="number"
        defaultValue={value}
        key={value}
        step="any"
        onKeyDown={stop}
        onBlur={(e) => {
          const n = Number.parseFloat(e.target.value)
          if (!Number.isNaN(n) && n !== value)
            onChange(n)
        }}
      />
    )
  }
  else if (typeof value === 'string') {
    input = <input defaultValue={value} key={value} onKeyDown={stop} onBlur={e => e.target.value !== value && onChange(e.target.value)} />
  }
  else {
    input = <code title="Edit this in the scene file">{JSON.stringify(value)}</code>
  }

  return (
    <label className={styles.field}>
      <span>{name}</span>
      {input}
    </label>
  )
}

function SceneSettings({ scene }: { scene: GameScene }) {
  const [open, setOpen] = useState(false)
  const { background, fog } = scene.settings
  const stop = (e: React.KeyboardEvent) => e.stopPropagation()

  return (
    <>
      <div className={`${styles.section} ${styles.clickable}`} onClick={() => setOpen(!open)}>
        {open ? '▾ Settings' : '▸ Settings'}
      </div>
      {open && (
        <div className={styles.details}>
          <label className={styles.field}>
            <span>background</span>
            <input type="checkbox" checked={!!background} onChange={e => scene.setSettings({ background: e.target.checked ? '#87ceeb' : undefined })} />
            {background && <input type="color" value={background} onChange={e => scene.setSettings({ background: e.target.value })} />}
          </label>
          <label className={styles.field}>
            <span>fog</span>
            <input type="checkbox" checked={!!fog} onChange={e => scene.setSettings({ fog: e.target.checked ? { color: background ?? '#ffffff', density: 0.01 } : undefined })} />
            {fog && <input type="color" value={fog.color} onChange={e => scene.setSettings({ fog: { ...fog, color: e.target.value } })} />}
          </label>
          {fog && (
            <label className={styles.field}>
              <span>fog density</span>
              <input
                type="number"
                step="0.001"
                min="0"
                defaultValue={fog.density}
                onKeyDown={stop}
                onBlur={e => scene.setSettings({ fog: { ...fog, density: Number.parseFloat(e.target.value) || 0 } })}
              />
            </label>
          )}
        </div>
      )}
    </>
  )
}
