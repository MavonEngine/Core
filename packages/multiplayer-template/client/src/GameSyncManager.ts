import type GameObjectInterface from '@mavonengine/core/World/GameObjectInterface'
import type { SV_CHAT, SV_TREES } from '@template/server/Commands/Server'
import type NetworkManager from './NetworkManager'
import type PlayerController from './PlayerController'
import Game from '@mavonengine/core/Game'
import NetworkedActor from '@mavonengine/core/Networking/NetworkedActor'
import NetworkedEntityFactory from '@mavonengine/core/Networking/NetworkedEntityFactory'
import NetworkedGameObject from '@mavonengine/core/Networking/NetworkedGameObject'
import { registerChatNodes } from '@template/server/Base/Npc/sayInChat'
import { ServerCommand } from '@template/server/Commands/Server'
import { Vector2 } from 'three'
import Character from './Entities/Player'
import ClientServerNpc from './Entities/ServerNpc'
import Trees from './World/Trees'

// The Say in Chat node: graphs using it run on the server, but the editor needs to know it to edit them
registerChatNodes()

export default class GameSyncManager implements GameObjectInterface {
  private networkManager: NetworkManager
  /** Null while the editor watches the game: it has no player of its own */
  playerController: PlayerController | null
  private trees: Trees | null = null

  /**
   * Client-side despawn distance should be less than server sync distance
   * so the entity never gets stuck at the boundary.
   */
  static DESPAWN_DISTANCE = 150

  constructor(networkManager: NetworkManager, playerController: PlayerController | null) {
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
        ? this.playerController?.player
        : Game.instance().world.entities.items.get(chat.playerId)

      if (entity instanceof Character || entity instanceof ClientServerNpc) {
        entity.showChatBubble(chat.message)
      }
    })

    this.networkManager.socket.on(ServerCommand.SV_REMOVE_ENTITY, (data: any) => {
      this.handleEntityRemove(data.id)
    })

    this.listenForNpcClicks()
  }

  private readonly abort = new AbortController()

  /**
   * A click on an NPC (not a drag, which orbits the camera) tells the server, whose logic graph for it answers.
   * Not in the editor, where clicks select objects
   */
  private listenForNpcClicks() {
    const canvas = Game.instance().canvas
    let down: { x: number, y: number } | undefined
    canvas.addEventListener('pointerdown', (e) => {
      down = { x: e.clientX, y: e.clientY }
    }, { signal: this.abort.signal })
    canvas.addEventListener('pointerup', (e) => {
      const start = down
      down = undefined
      if (!start || Game.instance().editor || Math.hypot(e.clientX - start.x, e.clientY - start.y) > 5)
        return

      const rect = canvas.getBoundingClientRect()
      const pointer = new Vector2(
        ((e.clientX - rect.left) / rect.width) * 2 - 1,
        -((e.clientY - rect.top) / rect.height) * 2 + 1,
      )
      const raycaster = Game.instance().rayCaster
      raycaster.setFromCamera(pointer, Game.instance().camera.instance)
      const npcs = [...ClientServerNpc.all].filter(npc => npc.model.instance)
      const hit = raycaster.intersectObjects(npcs.map(npc => npc.model.instance), true)[0]
      const npc = hit && npcs.find(candidate => candidate.owns(hit.object))
      if (npc)
        this.networkManager.sendNpcClick(npc.id)
    }, { signal: this.abort.signal })
  }

  destroy(): void {
    this.abort.abort()
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
        this.playerController?.updateFromNetwork(inEntity)
      }
    }

    // Despawn remote entities that left the sync radius. The editor is sent every entity, so it has none
    const player = this.playerController?.player
    if (!player)
      return

    for (const [id, entity] of Game.instance().world.entities.items) {
      if (
        !receivedIds.has(id)
        && entity instanceof NetworkedActor
        && entity.position.distanceTo(player.position) > GameSyncManager.DESPAWN_DISTANCE
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
