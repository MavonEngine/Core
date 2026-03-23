import type { Vector3 } from 'three'
import type { EditorHelperAttachment } from '../../Editor/EditorHelper'
import type Emitter from './Emitter'
import { WithEditorHelper } from '../../Editor/WithEditorHelper'
import GameObject from '../../World/GameObject'

/**
 * A particle effect can be made up of multiple emitters.
 * For example a gunshot has smoke and sparks as individual emmiters.
 */
export default class ParticleEffect extends WithEditorHelper(GameObject) implements EditorHelperAttachment {
  emitters: Emitter[] = []
  persistent = false

  destroy(): void {
    this.emitters.forEach(e => e.destroy())
    this.emitters = []
    super.destroy()
  }

  onMove(delta: Vector3): void {
    this.emitters.forEach(e => e.mesh.position.add(delta))
  }

  update(delta: number): void {
    this.emitters.forEach(emitter => emitter.update(delta))
    this.emitters = this.emitters.filter((emitter) => {
      if (emitter.garbageCollect) {
        emitter.destroy()
      }

      return !emitter.garbageCollect
    })
  }
}
