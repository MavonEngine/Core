import type { Object3D } from 'three'
import { useCallback, useEffect, useRef, useState } from 'react'
import styles from './SceneExplorer.module.css'

interface SceneItem {
  uuid: string
  name: string
  type: string
  children: SceneItem[]
}

function buildTree(object: Object3D): SceneItem {
  return {
    uuid: object.uuid,
    name: object.name || object.type,
    type: object.type,
    children: object.children
      .filter(c => !c.userData.isEditorInternal && c.userData.editorHelper?.mesh !== c)
      .map(c => buildTree(c)),
  }
}

function getTypeIcon(type: string): { paths: string[], color: string } {
  if (type.includes('Light')) {
    return {
      paths: ['M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41'],
      color: 'var(--accent-yellow)',
    }
  }
  if (type === 'Mesh') {
    return {
      paths: ['M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z'],
      color: 'var(--icon-default)',
    }
  }
  if (type === 'Group') {
    return {
      paths: ['M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z'],
      color: 'var(--accent-green)',
    }
  }
  if (type === 'Points') {
    return {
      paths: ['M12 12m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0', 'M12 5m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0', 'M12 19m-1 0a1 1 0 1 0 2 0a1 1 0 1 0-2 0'],
      color: 'var(--accent-purple)',
    }
  }
  return {
    paths: ['M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z'],
    color: 'var(--icon-default)',
  }
}

interface NodeProps {
  item: SceneItem
  selectedUuid: string | null
  depth: number
  onSelect(uuid: string): void
}

function SceneNode({ item, selectedUuid, depth, onSelect }: NodeProps) {
  const [expanded, setExpanded] = useState(true)
  const hasChildren = item.children.length > 0
  const isSelected = item.uuid === selectedUuid
  const rowRef = useRef<HTMLDivElement>(null)
  const icon = getTypeIcon(item.type)

  useEffect(() => {
    if (isSelected) {
      rowRef.current?.scrollIntoView({ block: 'nearest' })
    }
  }, [isSelected])

  return (
    <div>
      <div
        ref={rowRef}
        className={`${styles.row} ${isSelected ? styles.selected : ''}`}
        style={{ paddingLeft: `${depth * 16 + 8}px` }}
        onClick={() => onSelect(item.uuid)}
      >
        <span
          className={styles.arrow}
          style={{ visibility: hasChildren ? 'visible' : 'hidden' }}
          onClick={(e) => {
            e.stopPropagation()
            setExpanded(v => !v)
          }}
        >
          {expanded ? '▾' : '▸'}
        </span>
        <span className={styles.typeIcon}>
          <svg viewBox="0 0 24 24" fill="none" stroke={icon.color} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {icon.paths.map((d, i) => <path key={i} d={d} />)}
          </svg>
        </span>
        <span className={styles.name}>{item.name}</span>
      </div>
      {expanded && hasChildren && item.children.map(child => (
        <SceneNode
          key={child.uuid}
          item={child}
          selectedUuid={selectedUuid}
          depth={depth + 1}
          onSelect={onSelect}
        />
      ))}
    </div>
  )
}

export default function SceneExplorer() {
  const [items, setItems] = useState<SceneItem[]>([])
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null)

  const refresh = useCallback(() => {
    const scene = window.Game?.scene
    if (!scene)
      return
    const filtered = scene.children.filter(c => !c.userData.isEditorInternal && c.userData.editorHelper?.mesh !== c)
    setItems(filtered.map(c => buildTree(c)))
  }, [])

  useEffect(() => {
    refresh()

    function onObjectSelected(obj: Object3D) {
      if (obj.userData.editorHelper) {
        const scene = window.Game?.scene
        const match = scene?.children.find(
          c => !c.userData.isEditorInternal && !c.userData.editorHelper && c.position.equals(obj.position),
        )
        setSelectedUuid(match?.uuid ?? null)
      }
      else {
        setSelectedUuid(obj.uuid)
      }
    }

    function onSceneChanged() {
      refresh()
    }

    function onObjectDeselected() {
      setSelectedUuid(null)
    }

    window.Game.editor?.on('objectSelected', onObjectSelected)
    window.Game.editor?.on('objectDeselected', onObjectDeselected)
    window.Game.editor?.on('sceneChanged', onSceneChanged)
    window.Game.editor?.on('assetDropped', onSceneChanged)

    return () => {
      window.Game.editor?.off('objectSelected', onObjectSelected)
      window.Game.editor?.off('objectDeselected', onObjectDeselected)
      window.Game.editor?.off('sceneChanged', onSceneChanged)
      window.Game.editor?.off('assetDropped', onSceneChanged)
    }
  }, [refresh])

  const handleSelect = useCallback((uuid: string) => {
    const scene = window.Game?.scene
    if (!scene)
      return
    let found: Object3D | null = null
    scene.traverse((obj) => {
      if (obj.uuid === uuid)
        found = obj
    })
    if (found) {
      window.Game.editor?.selectObject(found)
    }
  }, [])

  if (items.length === 0) {
    return <div className={styles.empty}>Scene is empty</div>
  }

  return (
    <div className={styles.container} data-testid="scene-explorer">
      {items.map(item => (
        <SceneNode
          key={item.uuid}
          item={item}
          selectedUuid={selectedUuid}
          depth={0}
          onSelect={handleSelect}
        />
      ))}
    </div>
  )
}
