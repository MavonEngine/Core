import type { Vector3 } from 'three'
import BasePlayer from '../../Base/Player'
import IdleState from '../../Player/IdleState'

/**
 * Server-side player. Extends the shared Base/Player with server-specific logic.
 * Kicks off the initial idle state and can be extended with server-only behaviour
 * (e.g. hit detection, inventory, abilities).
 */
export default class Player extends BasePlayer {
  constructor(id?: string, spawn?: Vector3) {
    super(id, spawn)

    this.state.push(new IdleState(this))
  }
}
