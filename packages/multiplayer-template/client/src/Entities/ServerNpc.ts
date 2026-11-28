import NetworkedEntityFactory from '@mavonengine/core/Networking/NetworkedEntityFactory'
import { registerSceneObject } from '@mavonengine/core/Scene/SceneObjectRegistry'
import ServerNpc, { SERVER_NPC_TYPE } from '@template/server/Base/Npc/ServerNpc'
import { CapsuleGeometry, Mesh, MeshBasicMaterial, Vector3 } from 'three'
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
  /**
   * What clicks and the hover cursor test against: an invisible capsule around the model, so the gaps between its
   * arms and legs count too, and it's cheaper than testing the animated model. Set once the model has loaded
   */
  hitArea?: Mesh<CapsuleGeometry, MeshBasicMaterial>

  constructor(id: string, position: Vector3) {
    super(id, position)
    // Its position is its feet on the ground. It never stops, so it always walks
    this.model = new PlayerGraphicsComponent(this, {
      footOffset: 0,
      onReady: () => {
        const walk = this.model.animationsMap.get('walk')
        if (walk)
          this.model.fadeToAction(walk, 0)
        // In the model, so it moves and turns with it. Raycasts still hit it while it isn't drawn
        this.hitArea = new Mesh(new CapsuleGeometry(0.45, 1, 4, 8), new MeshBasicMaterial())
        this.hitArea.visible = false
        this.hitArea.position.y = 0.95
        this.model.instance.add(this.hitArea)
      },
    })
    this.model.init()
    // Over its head: the label sits this far above the position, like a player's over its middle
    this.label = new PlayerLabel(this, this.name)
    this.label.offset.y += 0.8
    ClientServerNpc.all.add(this)
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
    this.hitArea?.geometry.dispose()
    this.hitArea?.material.dispose()
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
