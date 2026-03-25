import type { Vector3 } from 'three'
import RAPIER from '@dimforge/rapier3d-compat'
import BaseGame from '@mavonengine/core/BaseGame'
import GameObject from '@mavonengine/core/World/GameObject'

export default class Tree extends GameObject {
  collider?: InstanceType<typeof RAPIER.Collider>

  constructor(position: Vector3) {
    super(undefined, position)
    this.addCollider(position)
  }

  private addCollider(position: Vector3) {
    this.collider = BaseGame.instance().physicsWorld!.createCollider(
      RAPIER.ColliderDesc.cylinder(2, 0.5),
    )
    this.collider.setTranslation({ x: position.x, y: position.y + 2, z: position.z })
  }

  destroy(): void {
    BaseGame.instance().physicsWorld!.removeCollider(this.collider!, false)
    super.destroy()
  }

  update(_delta: number): void {}
}
