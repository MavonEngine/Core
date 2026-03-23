import type NetworkedEntity from './NetworkedEntity'
import type NetworkedEntityState from './NetworkedEntityState'
import Actor from '../World/Actor'
import { NetworkedGameObjectMixin } from './NetworkedGameObject'

export default abstract class NetworkedActor extends NetworkedGameObjectMixin(Actor) implements NetworkedEntity {
  abstract $typeName: string

  declare state: NetworkedEntityState[]

  /**
   * This is for winston logger meta info
   */
  get message() {
    return `${super.message} - ${this.$typeName}`
  }

  abstract updateFromNetwork: (data: object) => void
}
