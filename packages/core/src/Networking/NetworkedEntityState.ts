import EntityState from '../World/Entity/State'

export default abstract class NetworkedEntityState extends EntityState {
  abstract readonly stateName: string

  toJSON() {
    return this.serialize()
  }

  public serialize() {
    return {
      stateName: this.stateName,
    }
  }
}
