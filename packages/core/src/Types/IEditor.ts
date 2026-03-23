import type { Object3D } from 'three'
import type EditorHelper from '../Editor/EditorHelper'

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
}
