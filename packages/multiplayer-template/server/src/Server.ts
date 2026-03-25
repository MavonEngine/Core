import type RAPIER from '@dimforge/rapier3d-compat'
import type { ServerChannel } from '@geckos.io/server'
import type winston from 'winston'
import type { CL_CHAT, CL_INIT, CL_MOVE } from './Commands/Client'
import type { SV_TREES } from './Commands/Server'
import BaseServer from '@mavonengine/core/Networking/Server/Server'
import { randRange } from '@mavonengine/core/Utils/Math'
import { Vector3 } from 'three'
import { ClientCommand, ServerCommand } from './Commands'
import Tree from './Base/Vegetation/Tree'
import Player from './Server/Entities/Player'

const TREE_COUNT = 15
const SPAWN_AREA = 80

export default class Server extends BaseServer<Player> {
  private treePositions: number[] = []
  private treeRotations: number[] = []
  private treeScales: number[] = []
  private trees: Tree[] = []

  constructor(logger: winston.Logger, physicsWorld?: RAPIER.World) {
    super(logger, physicsWorld)
    this.spawnTrees()
  }

  private spawnTrees() {
    for (let i = 0; i < TREE_COUNT; i++) {
      const x = randRange(-SPAWN_AREA, SPAWN_AREA)
      const z = randRange(-SPAWN_AREA, SPAWN_AREA)
      const rotY = Math.random() * Math.PI * 2
      const scale = randRange(0.01, 0.015)

      const position = new Vector3(x, 0, z)
      this.trees.push(new Tree(position))

      this.treePositions.push(x, 0, z)
      this.treeRotations.push(0, rotY, 0)
      this.treeScales.push(scale, scale, scale)
    }
  }

  getStateSyncDistance(): number {
    return 200
  }

  protected onConnection(channel: ServerChannel): Player {
    const spawnX = randRange(-8, 8)
    const spawnZ = randRange(-8, 8)
    // y = 0.5 so the box bottom face sits on the ground plane (y = 0)
    const player = new Player(channel.id, new Vector3(spawnX, 0.5, spawnZ))

    const treesData: SV_TREES = {
      positions: this.treePositions,
      rotations: this.treeRotations,
      scales: this.treeScales,
    }
    channel.emit(ServerCommand.SV_TREES, treesData, { reliable: true })

    channel.on(ClientCommand.CL_INIT, (command) => {
      const cmd = command as CL_INIT
      player.name = cmd.name

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

  protected onCommand(command: any, delta: number): void {
    const player = this.game.world.entities.items.get(command.playerId) as Player | null
    if (!player || player.isDead())
      return

    switch (command.type) {
      case ClientCommand.CL_MOVE: {
        const cmd = command as unknown as CL_MOVE
        player.keysPressed.clear()
        cmd.keys.forEach(key => player.keysPressed.add(key))
        player.rotation.y = cmd.yaw
        break
      }
    }
  }
}
