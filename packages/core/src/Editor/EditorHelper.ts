import type { ContainerApi } from '@tweakpane/core'
import type { Object3D, Vector3 } from 'three'
import { Mesh, MeshBasicMaterial, OctahedronGeometry } from 'three'
import Game from '../Game'
import UILabel from '../ui/UILabel'

export type PropertyField
  = | { type: 'color', label: string, getValue(): string, setValue(v: string): void }
    | { type: 'slider', label: string, min: number, max: number, step: number, getValue(): number, setValue(v: number): void }
    | { type: 'checkbox', label: string, getValue(): boolean, setValue(v: boolean): void }

export interface EditorHelperAttachment {
  addBindings?(folder: ContainerApi): void
  onMove?(delta: Vector3): void
  properties?: PropertyField[]
}

/**
 * A generic clickable gizmo that can be placed in the editor scene and linked
 * to any game object that has no selectable geometry of its own (e.g. a
 * particle effect, a light source, a trigger volume).
 *
 * Usage:
 *   const helper = new EditorHelper(position, 'Rain', particleEffect)
 *   editor.addHelper(helper)
 *
 * The helper's mesh is selectable via the existing raycast system.
 * When selected, read helper.attachment for tweakpane bindings.
 */
export default class EditorHelper {
  readonly mesh: Mesh
  readonly label: UILabel
  readonly labelText: string
  readonly attachment: EditorHelperAttachment | null
  owner?: { destroy(): void }
  private _prevPosition: Vector3

  constructor(position: Vector3, labelText: string, attachment: EditorHelperAttachment | null = null) {
    this.labelText = labelText
    this.attachment = attachment

    const geo = new OctahedronGeometry(0.35)
    const mat = new MeshBasicMaterial({ color: 0xFFAA00, wireframe: true })
    this.mesh = new Mesh(geo, mat)
    this.mesh.position.copy(position)
    this.mesh.userData.editorHelper = this
    this._prevPosition = position.clone()

    this.label = new UILabel(this.mesh, labelText)
    this.label.domElement.style.pointerEvents = 'auto'
    this.label.domElement.style.cursor = 'pointer'
    this.label.domElement.addEventListener('click', () => {
      Game.instance().editor?.selectObject(this.mesh)
    })

    Game.instance().scene.add(this.mesh)
  }

  update(delta: number) {
    this.label.update(delta)

    if (this.attachment?.onMove && !this._prevPosition.equals(this.mesh.position)) {
      const positionDelta = this.mesh.position.clone().sub(this._prevPosition)
      this.attachment.onMove(positionDelta)
      this._prevPosition.copy(this.mesh.position)
    }
  }

  dispose() {
    Game.instance().scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    ;(this.mesh.material as MeshBasicMaterial).dispose()
    this.label.destroy()
  }

  /** Returns the EditorHelper linked to an Object3D, or null. */
  static from(object: Object3D): EditorHelper | null {
    return (object.userData.editorHelper as EditorHelper) ?? null
  }
}
