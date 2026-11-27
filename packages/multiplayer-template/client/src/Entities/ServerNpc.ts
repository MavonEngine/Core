import Game from '@mavonengine/core/Game'
import NetworkedEntityFactory from '@mavonengine/core/Networking/NetworkedEntityFactory'
import { registerSceneObject } from '@mavonengine/core/Scene/SceneObjectRegistry'
import ServerNpc, { SERVER_NPC_TYPE } from '@template/server/Base/Npc/ServerNpc'
import { CapsuleGeometry, Mesh, MeshStandardMaterial, Vector3 } from 'three'
import PlayerLabel from './Player/PlayerLabel'

/**
 * An NPC the server moves, drawn where the state updates put it. Clicking it sends CL_NPC_CLICK (see GameSyncManager),
 * and its logic graph on the server answers in the chat.
 */
export default class ClientServerNpc extends ServerNpc {
  /** Every NPC drawn here, for clicks to find */
  static readonly all = new Set<ClientServerNpc>()

  readonly mesh: Mesh<CapsuleGeometry, MeshStandardMaterial>
  private readonly label: PlayerLabel

  constructor(id: string, position: Vector3) {
    super(id, position)
    this.mesh = new Mesh(
      new CapsuleGeometry(0.4, 0.9, 6, 16),
      new MeshStandardMaterial({ color: 0xE08A2E, roughness: 0.6 }),
    )
    this.mesh.castShadow = true
    this.mesh.userData.serverNpc = this
    Game.instance().scene.add(this.mesh)
    this.label = new PlayerLabel(this, this.name)
    this.syncMesh()
    ClientServerNpc.all.add(this)
  }

  /** Called by GameSyncManager when it talks in the chat */
  showChatBubble(message: string) {
    this.label.showChatBubble(message)
  }

  private syncMesh() {
    // Its position is its feet on the ground: the capsule stands on them
    this.mesh.position.set(this.position.x, this.position.y + 0.85, this.position.z)
    this.mesh.rotation.set(this.rotation.x, this.rotation.y, this.rotation.z)
  }

  update(delta: number): void {
    this.syncMesh()
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
    Game.instance().scene.remove(this.mesh)
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
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
