import BasePlayer from '@template/server/Base/Player'
import { syncStateStack } from '@mavonengine/core/Networking/syncState'
import { Vector3 } from 'three'
import IdleState from '../Player/IdleState'
import WalkingState from '../Player/WalkingState'
import PlayerLabel from '../ui/PlayerLabel'
import PlayerGraphicsComponent from './Player/PlayerGraphicsComponent'

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
    this.graphicalComponent.update(delta)
    this.label.update(delta)
  }

  updateFromNetwork = (data: {
    position: { x: number; y: number; z: number }
    rotation?: { x: number; y: number; z: number }
    state: { stateName: string }[]
    health: number
    name?: string
  }) => {
    this.position.set(data.position.x, data.position.y, data.position.z)
    this.rigidBody?.setTranslation({ x: data.position.x, y: data.position.y, z: data.position.z }, false)
    this.health = data.health

    if (!this.isLocalPlayer && data.rotation) {
      this.rotation.y = data.rotation.y
    }

    if (data.name && data.name !== this.name) {
      this.name = data.name
      this.label.setName(this.isLocalPlayer ? `You (${data.name})` : data.name)
    }

    const stateFactories = {
      idleState: (entity: BasePlayer) => new IdleState(entity),
      walkingState: (entity: BasePlayer) => new WalkingState(entity),
    }

    syncStateStack(this, data.state, stateFactories)
  }

  destroy(): void {
    this.graphicalComponent.destroy()
    this.label.destroy()
    super.destroy()
  }
}
