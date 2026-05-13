import NetworkedLivingActor from '../NetworkedLivingActor'

/**
 * Base class for connected clients / Players
 */
export default abstract class Player extends NetworkedLivingActor {
  $typeName = 'player'

  trackedEntities = new Set<string>()

  private _lastProcessedSequenceId = 0

  get lastProcessedSequenceId() {
    return this._lastProcessedSequenceId
  }

  updateLastProcessedSequenceId(sequenceId: number) {
    this._lastProcessedSequenceId = sequenceId
  }

  networkedFieldCallbacks(): Record<string, (value: unknown) => void> {
    return {
      ...super.networkedFieldCallbacks(),
      lastProcessedSequenceId: sequenceId => this._lastProcessedSequenceId = sequenceId as number,
    }
  }

  public serialize() {
    return {
      ...super.serialize(),
      $typeName: this.$typeName,
      lastProcessedSequenceId: this.lastProcessedSequenceId,
    }
  }
}
