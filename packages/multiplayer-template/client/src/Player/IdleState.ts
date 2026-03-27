import type Character from '../Entities/Player'
import ServerIdleState from '@template/server/Player/IdleState'

export default class IdleState extends ServerIdleState {
  declare entity: Character

  public enter(): void {
    const idleAnim = this.entity.graphicalComponent?.animationsMap.get('idle')
    if (idleAnim) {
      this.entity.graphicalComponent.fadeToAction(idleAnim, 0.2)
    }
  }
}
