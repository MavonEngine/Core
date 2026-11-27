import type { Object3D } from 'three'
import NetworkedEntityFactory from '@mavonengine/core/Networking/NetworkedEntityFactory'
import { registerSceneObject } from '@mavonengine/core/Scene/SceneObjectRegistry'
import ServerNpc, { SERVER_NPC_TYPE } from '@template/server/Base/Npc/ServerNpc'
import { Vector3 } from 'three'
import PlayerGraphicsComponent from './Player/PlayerGraphicsComponent'
import PlayerLabel from './Player/PlayerLabel'

/**
 * An NPC the server moves, drawn with the players' character model, walking, where the state updates put it. Clicking it sends CL_NPC_CLICK (see GameSyncManager),
 * and its logic graph on the server answers in the chat.
 */
export default class ClientServerNpc extends ServerNpc {
  /** Every NPC drawn here, for clicks to find */
  static readonly all = new Set<ClientServerNpc>()

  readonly model: PlayerGraphicsComponent
  private readonly label: PlayerLabel

  constructor(id: string, position: Vector3) {
    super(id, position)
    // Its position is its feet on the ground. It never stops, so it always walks
    this.model = new PlayerGraphicsComponent(this, {
      footOffset: 0,
      onReady: () => {
        const walk = this.model.animationsMap.get('walk')
        if (walk)
          this.model.fadeToAction(walk, 0)
      },
    })
    this.model.init()
    // Over its head: the label sits this far above the position, like a player's over its middle
    this.label = new PlayerLabel(this, this.name)
    this.label.offset.y += 0.8
    ClientServerNpc.all.add(this)
  }

  /** Whether `object` (a raycast hit) is part of its model */
  owns(object: Object3D): boolean {
    for (let o: Object3D | null = object; o; o = o.parent) {
      if (o === this.model.instance)
        return true
    }
    return false
  }

  /** Called by GameSyncManager when it talks in the chat */
  showChatBubble(message: string) {
    this.label.showChatBubble(message)
  }

  update(delta: number): void {
    this.label.update(delta)
  }

  networkedFieldCallbacks(): Record<string, (value: unknown) => void> {
    return {
      ...super.networkedFieldCallbacks(),
      name: (value) => {
        if (typeof value === 'string' && value !== this.name) {
          this.name = value
          this.label.setName(value)
        }
      },
    }
  }

  destroy(): void {
    ClientServerNpc.all.delete(this)
    this.model.destroy()
    this.label.destroy()
    super.destroy()
  }
}

NetworkedEntityFactory.instance.register('serverNpc', (data) => {
  const d = data as { id: string, position: { x: number, y: number, z: number } }
  return new ClientServerNpc(d.id, new Vector3(d.position.x, d.position.y, d.position.z)) as never
})

// Known to the editor by name. The server builds it: the client draws the one the server sends, not one of its own
registerSceneObject({
  type: SERVER_NPC_TYPE,
  label: 'Server NPC',
})
