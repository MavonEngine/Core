import type Player from '../Base/Player'
import NetworkedEntityState from '@mavonengine/core/Networking/NetworkedEntityState'
import WalkingState from './WalkingState'

export default class IdleState extends NetworkedEntityState {
  declare entity: Player
  stateName = 'idleState'

  update(_delta: number): NetworkedEntityState | void {
    const keys = this.entity.keysPressed
    if (keys.has('KeyW') || keys.has('KeyA') || keys.has('KeyS') || keys.has('KeyD')) {
      return new WalkingState(this.entity)
    }
  }
}
