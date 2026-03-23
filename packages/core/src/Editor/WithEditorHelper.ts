import type { Object3D, Vector3 } from 'three'
import type { EditorHelperAttachment } from './EditorHelper'
import Game from '../Game'
import EditorHelper from './EditorHelper'

/**
 * Mixin that lets any game object register itself as an EditorHelper gizmo.
 *
 * - Call `registerEditorHelper(position, label, attachment?)` once the world-space
 *   position is known (typically end of constructor).
 * - Call `tagWithHelper(mesh)` for every Three.js mesh that belongs to this object
 *   so that selecting and deleting any of those meshes in the editor also removes
 *   the gizmo (and vice-versa via `owner`).
 * - No-ops when no editor is active, safe in non-editor builds.
 */
export function WithEditorHelper<TBase extends abstract new (...args: any[]) => { destroy(): void }>(Base: TBase) {
  abstract class Mixed extends Base {
    editorHelper: EditorHelper | undefined

    registerEditorHelper(position: Vector3, label: string, attachment: EditorHelperAttachment | null = null): void {
      const editor = Game.instance().editor
      if (!editor)
        return
      this.editorHelper = new EditorHelper(position, label, attachment)
      this.editorHelper.owner = this
      editor.addHelper(this.editorHelper)
    }

    /** Tag a Three.js mesh so the editor can find this object's helper from it. */
    tagWithHelper(mesh: Object3D): void {
      if (this.editorHelper)
        mesh.userData.editorHelper = this.editorHelper
    }

    destroy(): void {
      if (this.editorHelper) {
        Game.instance().editor?.removeHelper(this.editorHelper)
        this.editorHelper.dispose()
        this.editorHelper = undefined
      }
      super.destroy()
    }
  }
  return Mixed
}
