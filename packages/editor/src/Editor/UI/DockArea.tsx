import type { EditorPanelLocation } from '@mavonengine/core/Types/IEditor'
import type { ErrorInfo, ReactNode } from 'react'
import type { EditorPanelDefinition } from '../panels'
import { Component, useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getEditorPanels, panelsAt, subscribeEditorPanels } from '../panels'
import styles from './DockArea.module.css'
import editorStyles from './Editor.module.css'
import PanelHeader from './PanelHeader'

export interface BuiltinPanel {
  id: string
  title: string
  element: ReactNode
  /** Wrap in the padded, scrolling panel body. Default true */
  padded?: boolean
}

interface Tab {
  id: string
  title: string
  builtin?: BuiltinPanel
  custom?: EditorPanelDefinition
}

/**
 * One dock of the editor (left, bottom or right): its built-in panels and the custom ones registered for it, as tabs.
 * Built-in panels stay mounted while hidden so they keep their state; custom panels mount when their tab is shown.
 */
export default function DockArea({ location, builtins }: { location: EditorPanelLocation, builtins: BuiltinPanel[] }) {
  const custom = panelsAt(useSyncExternalStore(subscribeEditorPanels, getEditorPanels), location)
  const tabs: Tab[] = [
    ...builtins.map(builtin => ({ id: builtin.id, title: builtin.title, builtin })),
    ...custom.map(panel => ({ id: panel.id, title: panel.title, custom: panel })),
  ]

  const storageKey = `editor-dock-${location}`
  const [activeId, setActiveId] = useState(() => localStorage.getItem(storageKey) ?? tabs[0]?.id)
  const active = tabs.find(tab => tab.id === activeId) ?? tabs[0]

  const select = (id: string) => {
    setActiveId(id)
    localStorage.setItem(storageKey, id)
  }

  return (
    <div className={editorStyles.panelContent}>
      {tabs.length === 1
        ? <PanelHeader title={tabs[0].title} />
        : (
            <div className={styles.tabs} role="tablist">
              {tabs.map(tab => (
                <button
                  key={tab.id}
                  role="tab"
                  aria-selected={tab === active}
                  className={`${styles.tab} ${tab === active ? styles.active : ''}`}
                  onClick={() => select(tab.id)}
                >
                  {tab.title}
                </button>
              ))}
            </div>
          )}

      {builtins.map(builtin => (
        <div
          key={builtin.id}
          className={builtin.padded === false ? styles.unpadded : editorStyles.panelBody}
          style={{ display: active?.builtin === builtin ? undefined : 'none' }}
        >
          {builtin.element}
        </div>
      ))}

      {active?.custom && (
        <div className={editorStyles.panelBody}>
          <PanelErrorBoundary key={active.custom.id} title={active.custom.title}>
            <CustomPanel panel={active.custom} />
          </PanelErrorBoundary>
        </div>
      )}
    </div>
  )
}

function CustomPanel({ panel }: { panel: EditorPanelDefinition }) {
  const editor = window.Game.editor!
  if (panel.component) {
    const Panel = panel.component
    return <Panel editor={editor} />
  }
  return <MountedPanel panel={panel} />
}

function MountedPanel({ panel }: { panel: EditorPanelDefinition }) {
  const ref = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const container = ref.current
    if (!container || !panel.mount)
      return
    const cleanup = panel.mount(container, window.Game.editor!)
    return () => {
      cleanup?.()
      container.replaceChildren()
    }
  }, [panel])

  return <div ref={ref} className={styles.mounted} />
}

/** A custom panel that throws shows its error instead of taking the editor down */
class PanelErrorBoundary extends Component<{ title: string, children: ReactNode }, { error?: Error }> {
  state: { error?: Error } = {}

  static getDerivedStateFromError(error: Error) {
    return { error }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    window.Game.logger?.error(`Editor panel ${this.props.title} crashed: ${error.message}`, info.componentStack)
  }

  render() {
    if (this.state.error) {
      return (
        <div className={styles.error}>
          <strong>{this.props.title}</strong>
          {' crashed: '}
          {this.state.error.message}
          <button onClick={() => this.setState({ error: undefined })}>Retry</button>
        </div>
      )
    }
    return this.props.children
  }
}
