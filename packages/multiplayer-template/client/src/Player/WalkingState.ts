import type Character from '../Entities/Player'
import ServerWalkingState from '@template/server/Player/WalkingState'

export default class WalkingState extends ServerWalkingState {
  declare entity: Character

  public enter(): void {
    const walkAnim = this.entity.graphicalComponent?.animationsMap.get('walk')
    if (walkAnim) {
      this.entity.graphicalComponent.fadeToAction(walkAnim, 0.2)
    }
  }
}
