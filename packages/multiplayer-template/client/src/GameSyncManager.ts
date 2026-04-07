import type GameObjectInterface from '@mavonengine/core/World/GameObjectInterface'
import type { SV_CHAT, SV_TREES } from '@template/server/Commands/Server'
import type NetworkManager from './NetworkManager'
import type PlayerController from './PlayerController'
import Game from '@mavonengine/core/Game'
import NetworkedActor from '@mavonengine/core/Networking/NetworkedActor'
import NetworkedGameObject from '@mavonengine/core/Networking/NetworkedGameObject'
import { ServerCommand } from '@template/server/Commands'
import { Vector3 } from 'three'
import Character from './Entities/Player'
import useNetworkState from './UI/composables/useNetworkState'
import Trees from './World/Trees'
import NetworkedEntityFactory from '@mavonengine/core/Networking/NetworkedEntityFactory'

export default class GameSyncManager implements GameObjectInterface {
  private networkManager: NetworkManager
  playerController: PlayerController
  private trees: Trees | null = null

  /**
   * Client-side despawn distance should be less than server sync distance
   * so the entity never gets stuck at the boundary.
   */
  static DESPAWN_DISTANCE = 150

  constructor(networkManager: NetworkManager, playerController: PlayerController) {
    this.networkManager = networkManager
    this.playerController = playerController

    this.networkManager.on(ServerCommand.SV_STATE, this.handleStateUpdate.bind(this))

    this.networkManager.on(ServerCommand.SV_TREES, (data: SV_TREES) => {
      this.trees?.destroy()
      this.trees = new Trees(data.positions, data.scales, data.rotations)
      Game.instance().world.add({ trees: this.trees })
    })

    this.networkManager.on(ServerCommand.SV_CHAT, (chat: SV_CHAT) => {
      if (!chat.playerId)
        return

      // Local player is keyed as 'localPlayer', not by socket id
      const isLocal = chat.playerId === this.networkManager.socket.id
      const entity = isLocal
        ? this.playerController.player
        : Game.instance().world.entities.items.get(chat.playerId)

      if (entity instanceof Character) {
        entity.showChatBubble(chat.message)
      }
    })

    this.networkManager.socket.on(ServerCommand.SV_REMOVE_ENTITY, (data: any) => {
      this.handleEntityRemove(data.id)
    })
  }

  destroy(): void {
    this.trees?.destroy()
    this.trees = null
    this.networkManager.destroy()
  }

  update(_delta: number) { }

  private handleStateUpdate(data: any) {
    const updatedEntities: any[] = data.entities
    const receivedIds = new Set<string>()

    for (const inEntity of updatedEntities) {
      receivedIds.add(inEntity.id)

      const existing = Game.instance().world.entities.items.get(inEntity.id)

      if (existing instanceof NetworkedGameObject) {
        (existing as NetworkedActor).updateFromNetwork(inEntity)
      }
      else if (this.networkManager.socket.id !== inEntity.id) {
        const instance = NetworkedEntityFactory.instance.create(inEntity.$typeName, inEntity)
        if (instance)
          Game.instance().world.entities.items.set(inEntity.id, instance)
      }
      else {
        // This is our own player coming back from the server
        this.playerController.updateFromNetwork(inEntity)
      }
    }

    // Despawn remote entities that left the sync radius
    for (const [id, entity] of Game.instance().world.entities.items) {
      if (
        !receivedIds.has(id)
        && entity instanceof NetworkedActor
        && entity.position.distanceTo(this.playerController.player.position) > GameSyncManager.DESPAWN_DISTANCE
      ) {
        this.handleEntityRemove(id)
      }
    }
  }

  private handleEntityRemove(entityId: string) {
    const entity = Game.instance().world.entities.items.get(entityId)
    if (!entity)
      return

    entity.destroy()
    Game.instance().world.entities.items.delete(entityId)
  }
}
