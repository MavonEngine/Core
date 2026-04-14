import type { Intersection, Object3D, Object3DEventMap, Vector3 } from 'three'
import type NetworkedEntity from './NetworkedEntity'
import type NetworkedEntityState from './NetworkedEntityState'
import LivingActor from '../World/LivingActor'
import { NetworkedGameObjectMixin } from './NetworkedGameObject'

export default abstract class NetworkedLivingActor extends NetworkedGameObjectMixin(LivingActor) implements NetworkedEntity {
  abstract $typeName: string

  declare state: NetworkedEntityState[]

  /**
   * This is for winston logger meta info
   */
  get message() {
    return `${super.message} - ${this.$typeName}`
  }

  update(delta: number): void {
    super.update(delta)

    /**
     * Update the state hash if it is changed
     */
    if (this.stateHash !== this.previousStateHash) {
      this.previousStateHash = this.stateHash
      this.needsSync = true
    }
  }

  networkedFieldCallbacks(): Record<string, (value: unknown) => void> {
    return {
      ...super.networkedFieldCallbacks(),
      health: health => this.health = health as number,
    }
  }

  public serialize(): {
    id: string
    position: Vector3
    rotation: Vector3
    scale: Vector3
    health: number
    state: NetworkedEntityState[]
  } {
    return {
      ...super.serialize(),
      state: this.state,
    } as ReturnType<NetworkedLivingActor['serialize']>
  }

  isDead(): boolean {
    return this.health <= 0
  }

  kill(_hit?: Intersection<Object3D<Object3DEventMap>>, _direction?: Vector3) {
    this.health = 0
  }
}
