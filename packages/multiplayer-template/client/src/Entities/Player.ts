import { syncStateStack } from '@mavonengine/core/Networking/syncState'
import BasePlayer from '@template/server/Base/Player'
import { Vector3 } from 'three'
import IdleState from '../Player/IdleState'
import WalkingState from '../Player/WalkingState'
import PlayerGraphicsComponent from './Player/PlayerGraphicsComponent'
import PlayerLabel from './Player/PlayerLabel'

export default class Character extends BasePlayer {
  graphicalComponent: PlayerGraphicsComponent
  private label: PlayerLabel

  readonly isLocalPlayer: boolean

  constructor(id: string, isLocalPlayer: boolean, spawn = new Vector3()) {
    super(id, spawn)
    this.isLocalPlayer = isLocalPlayer

    this.graphicalComponent = new PlayerGraphicsComponent(this)
    this.graphicalComponent.init()

    this.label = new PlayerLabel(this, isLocalPlayer ? 'You' : 'Player', isLocalPlayer)
  }

  /** Called by GameSyncManager when this player sends a chat. */
  showChatBubble(message: string) {
    this.label.showChatBubble(message)
  }

  update(delta: number): void {
    this.rigidBody!.setTranslation({ x: this.position.x, y: this.position.y, z: this.position.z }, true)

    this.graphicalComponent.update(delta)
    this.label.update(delta)
  }

  networkedFieldCallbacks(): Record<string, (value: unknown) => void> {
    return {
      ...super.networkedFieldCallbacks(),
      name: (v) => {
        if (v && !this.name) {
          this.label.setName(v as string)
          this.name = v as string
        }
      },
    }
  }

  private stateFactories = {
    idleState: (entity: BasePlayer) => new IdleState(entity),
    walkingState: (entity: BasePlayer) => new WalkingState(entity),
  }

  /**
   * Applied on the client when server state arrives.
   */
  updateFromNetwork(data: Record<string, unknown>): void {
    super.updateFromNetwork(data)

    syncStateStack(this, data.state as { stateName: string }[], this.stateFactories)
  }

  destroy(): void {
    this.graphicalComponent.destroy()
    this.label.destroy()
    super.destroy()
  }
}
