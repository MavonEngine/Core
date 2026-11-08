import type { EditorPanel, EditorPanelLocation } from '@mavonengine/core/Types/IEditor'
import type IEditor from '@mavonengine/core/Types/IEditor'
import type { ComponentType } from 'react'

export type { EditorPanelLocation }

/**
 * A panel for the editor. Same as core's `EditorPanel`, with `component` typed as a React component.
 */
export interface EditorPanelDefinition extends Omit<EditorPanel, 'component'> {
  component?: ComponentType<{ editor: IEditor }>
}

const panels = new Map<string, EditorPanelDefinition>()
const listeners = new Set<() => void>()
let snapshot: EditorPanelDefinition[] = []

function changed() {
  snapshot = [...panels.values()]
  listeners.forEach(listener => listener())
}

/**
 * Dock a panel in the editor. Works before the editor boots too, e.g. next to `Editor.registerListener()`.
 * Returns a function that removes it again.
 */
export function registerEditorPanel(panel: EditorPanelDefinition | EditorPanel): () => void {
  if (!panel.component && !panel.mount)
    throw new Error(`Editor panel ${panel.id} needs a component or a mount function`)

  const definition = panel as EditorPanelDefinition
  panels.set(definition.id, definition)
  changed()

  return () => {
    if (panels.get(definition.id) === definition)
      unregisterEditorPanel(definition.id)
  }
}

export function unregisterEditorPanel(id: string): void {
  if (panels.delete(id))
    changed()
}

/** Every registered panel, for `useSyncExternalStore` */
export function getEditorPanels(): EditorPanelDefinition[] {
  return snapshot
}

export function subscribeEditorPanels(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function panelsAt(all: EditorPanelDefinition[], location: EditorPanelLocation): EditorPanelDefinition[] {
  return all
    .filter(panel => panel.location === location)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
}
