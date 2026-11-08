import type RAPIER from '@dimforge/rapier3d-compat'
import type { ServerChannel } from '@geckos.io/server'
import type { ServerOptions } from '@mavonengine/core/Networking/Server/Server'
import type winston from 'winston'
import type { CL_CHAT, CL_INIT, CL_MOVE } from './Commands/Client'
import type { SV_TREES } from './Commands/Server'
import BaseServer from '@mavonengine/core/Networking/Server/Server'
import { registerSceneObject } from '@mavonengine/core/Scene/SceneObjectRegistry'
import { randRange } from '@mavonengine/core/Utils/Math'
import { Vector3 } from 'three'
import TreeField, { TREE_FIELD_TYPE } from './Base/Vegetation/TreeField'
import { ClientCommand } from './Commands/Client'
import { ServerCommand } from './Commands/Server'
import Player from './Server/Entities/Player'

/**
 * Scene objects the server builds from scenes/*.json. Lights, the ground plane and other visuals
 * are only built by the client; the server keeps their data untouched.
 */
registerSceneObject<TreeField>({
  type: TREE_FIELD_TYPE,
  label: 'Tree field',
  server: data => new TreeField(data),
})

export default class Server extends BaseServer<Player> {
  constructor(logger: winston.Logger, physicsWorld?: RAPIER.World, options?: ServerOptions) {
    super(logger, physicsWorld, options)

    // Also runs when the scene file changes (the editor saved it): every client gets the new trees
    this.game.on('sceneLoaded', () => {
      this.gameSocket.emit(ServerCommand.SV_TREES, this.treesPacket(), { reliable: true })
    })
  }

  /** Every tree of every tree field in the scene */
  private treesPacket(): SV_TREES {
    const packet: SV_TREES = { positions: [], rotations: [], scales: [] }
    for (const entry of this.game.activeScene?.getEntries() ?? []) {
      if (entry.object instanceof TreeField) {
        const trees = entry.object.packet
        packet.positions.push(...trees.positions)
        packet.rotations.push(...trees.rotations)
        packet.scales.push(...trees.scales)
      }
    }
    return packet
  }

  getStateSyncDistance(): number {
    return 200
  }

  protected onConnection(channel: ServerChannel): Player {
    const spawnX = randRange(-8, 8)
    const spawnZ = randRange(-8, 8)
    // y = 0.5 so the box bottom face sits on the ground plane (y = 0)
    const player = new Player(channel.id, new Vector3(spawnX, 0.5, spawnZ))

    channel.emit(ServerCommand.SV_TREES, this.treesPacket(), { reliable: true })

    channel.on(ClientCommand.CL_INIT, (command) => {
      const cmd = command as CL_INIT
      player.name = cmd.name
      player.setDisplayName(cmd.name)

      this.gameSocket.emit(ServerCommand.SV_CHAT, {
        playerId: '',
        playerName: 'Server',
        message: `${player.name} joined the game!`,
      }, { reliable: true })
    })

    channel.on(ClientCommand.CL_CHAT, (command) => {
      const cmd = command as CL_CHAT

      this.gameSocket.emit(ServerCommand.SV_CHAT, {
        playerId: channel.id!,
        playerName: player.name || 'Unknown',
        message: cmd.message,
      }, { reliable: true })
    })

    channel.onDisconnect(() => {
      this.gameSocket.emit(ServerCommand.SV_CHAT, {
        playerId: '',
        playerName: 'Server',
        message: `${player.name || 'A player'} left the game.`,
      }, { reliable: true })
    })

    return player
  }

  protected onCommand(command: any, _delta: number): void {
    const player = this.game.world.entities.items.get(command.playerId) as Player | null
    if (!player || player.isDead())
      return

    switch (command.type) {
      case ClientCommand.CL_MOVE: {
        const cmd = command as unknown as CL_MOVE
        player.keysPressed.clear()
        cmd.keys.forEach(key => player.keysPressed.add(key))
        player.lastMovementCommandTimestamp = performance.now()
        player.rotation.y = cmd.yaw
        break
      }
    }
  }
}
