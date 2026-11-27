import NetworkedGameObject from '@mavonengine/core/Networking/NetworkedGameObject'

/** Its type in scene files */
export const SERVER_NPC_TYPE = 'ServerNpc'

/**
 * A character the server moves, shared by both sides. The server builds it from the scene and moves it (a logic
 * graph does, see graphs/server-npc.graph.json); clients get it in the state updates like any networked entity and
 * draw it (client/src/Entities/ServerNpc.ts).
 */
export default class ServerNpc extends NetworkedGameObject {
  $typeName = 'serverNpc'

  /** Shown over it, and as who speaks when it talks in the chat */
  name = 'Server NPC'

  update(_delta: number): void {}
}
