import type { Object3D } from 'three'
import type EditorHelper from '../Editor/EditorHelper'

export type EditorPanelLocation = 'left' | 'bottom' | 'right'

/**
 * A custom panel docked in the editor, e.g. for your own dev tooling.
 * Panels sharing a location are shown as tabs next to the built-in one (Explorer, Assets, Properties).
 *
 * Give either `component`, a React component rendered with the editor's React, or `mount` to render
 * into a DOM element with anything else (Vue, plain DOM, Tweakpane…).
 */
export interface EditorPanel {
  /** Unique; adding a panel with the same id replaces it */
  id: string
  title: string
  location: EditorPanelLocation
  /** Lower comes first. Built-in panels are 0 */
  order?: number
  /** A React function component. Typed loosely so core does not depend on React */
  component?(props: { editor: IEditor }): unknown
  /** Render into `container`, return a cleanup function. Called each time the panel's tab is shown */
  mount?(container: HTMLElement, editor: IEditor): void | (() => void)
}

/**
 * Minimal interface that core code requires from an editor implementation.
 * The full Editor class (in @mavonengine/editor) must satisfy this interface.
 */
export default interface IEditor {
  update(delta: number): void
  addHelper(helper: EditorHelper): void
  removeHelper(helper: EditorHelper): void
  selectObject(obj: Object3D): void
  addLightHelper(helper: Object3D): void
  removeLightHelper(helper: Object3D): void
  setShowHelpers(visible: boolean): void
  on(event: string, callback: (event?: any) => void): void
  off(event: string, callback: (event?: any) => void): void
  trigger(name: string, event?: any): void
  availableAssetCategories: string[]
  activeAssetCategory: 'Object' | '_texture' | 'CubeTexture' | 'AudioBuffer' | 'Font'
  setActiveAssetCategory(value: 'Object' | '_texture' | 'CubeTexture' | 'AudioBuffer' | 'Font'): void
  /** Dock a custom panel. Returns a function that removes it */
  addPanel(panel: EditorPanel): () => void
  removePanel(id: string): void
  /** Save the active scene to its file through the dev server */
  saveScene(): Promise<boolean>
}
