import type Player from '../Base/Player'
import NetworkedEntityState from '@mavonengine/core/Networking/NetworkedEntityState'
import { Vector3 } from 'three'

const SPEED = 5 // units per second
const UP = new Vector3(0, 1, 0)

export default class WalkingState extends NetworkedEntityState {
  declare entity: Player
  stateName = 'walkingState'

  update(delta: number): NetworkedEntityState | void {
    const keys = this.entity.keysPressed
    const moveDir = new Vector3()

    if (keys.has('KeyW'))
      moveDir.z -= 1
    if (keys.has('KeyS'))
      moveDir.z += 1
    if (keys.has('KeyA'))
      moveDir.x -= 1
    if (keys.has('KeyD'))
      moveDir.x += 1

    if (moveDir.lengthSq() === 0) {
      this.leave()
      return
    }

    moveDir.normalize().applyAxisAngle(UP, this.entity.rotation.y).multiplyScalar(SPEED * delta)
    this.entity.horizontalIntent.copy(moveDir)
  }
}
