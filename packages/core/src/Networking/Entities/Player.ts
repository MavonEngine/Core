import NetworkedLivingActor from '../NetworkedLivingActor'

/**
 * Base class for connected clients / Players
 */
export default abstract class Player extends NetworkedLivingActor {
  $typeName = 'player'

  trackedEntities = new Set<string>()

  private _lastProcessedSequenceId = 0

  private _displayName: string | null = null

  get lastProcessedSequenceId() {
    return this._lastProcessedSequenceId
  }

  /**
   * Human readable name, shown in tools like the CLI dashboard.
   * Falls back to the id until the game sets one.
   */
  get displayName(): string {
    return this._displayName ?? this.id
  }

  /**
   * Pass null to fall back to the id again.
   */
  setDisplayName(name: string | null) {
    this._displayName = name
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
