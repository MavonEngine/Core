import NetworkedLivingActor from '../NetworkedLivingActor'

/**
 * Base class for connected clients / Players
 */
export default abstract class Player extends NetworkedLivingActor {
  $typeName = 'player'

  trackedEntities = new Set<string>()

  public serialize() {
    return {
      ...super.serialize(),
      $typeName: this.$typeName,
    }
  }
}
