import type RAPIER from '@dimforge/rapier3d-compat'
import type { Data, GeckosServer, ServerChannel } from '@geckos.io/server'
import type { Express } from 'express'
import type winston from 'winston'
import type GameObject from '../../World/GameObject'
import type Player from '../Entities/Player'
import type NetworkedActor from '../NetworkedActor'
import { Buffer } from 'node:buffer'
import geckos from '@geckos.io/server'
import express from 'express'
import BaseGame from '../../BaseGame'
import { ServerCommand } from './Commands'
import BandwidthTracker from './Stats/BandwidthTracker'
import CpuTracker from './Stats/CpuTracker'
import ServerWorld from './World'

let instance: Server<GameObject>

export default abstract class Server<TClient extends GameObject> {
  game: BaseGame

  private commandBuffer: object[] = []

  gameSocket: GeckosServer
  httpServer: Express = express()
  protected logger: winston.Logger

  private onHttpCallback?: (httpServer: Express) => void

  lastTime = performance.now()

  bandwidthTracker = new BandwidthTracker()
  private cpuTracker: CpuTracker

  protected abstract onConnection(channel: ServerChannel): TClient
  protected abstract onCommand(command: any, delta: number): void

  constructor(logger: winston.Logger, phyicsWorld?: RAPIER.World) {
    instance = this as unknown as Server<GameObject>

    this.game = new BaseGame(logger, phyicsWorld)
    this.game.world = new ServerWorld()

    this.gameSocket = geckos()
    this.logger = logger
    this.cpuTracker = new CpuTracker(this.logger)

    this.gameSocket.onConnection((channel) => {
      this.logger.info(`Connected: ${channel.id}`)

      const client = this.onConnection(channel)
      this.game.world.entities.items.set(client.id!.toString(), client)

      this.logger.info(`${(this.game.world as ServerWorld).players.length} total players connected`)

      channel.on('ping', () => {
        channel.emit('pong')
      })

      channel.onDisconnect(() => {
        const playerId = channel.id!
        const disconnectedPlayer = BaseGame.instance().world.entities.items.get(playerId) as Player

        if (!disconnectedPlayer)
          return

        disconnectedPlayer.destroy()

        // Only notify players within visibility radius
        this.gameSocket.connectionsManager.connections.forEach((conn, connId) => {
          if (connId === playerId)
            return

          const otherPlayer = this.game.world.entities.items.get(connId!) as Player
          if (!otherPlayer)
            return

          const dist = otherPlayer.position.distanceTo(disconnectedPlayer.position)
          if (dist <= this.getStateSyncDistance()) {
            conn.channel.emit(ServerCommand.SV_REMOVE_ENTITY, {
              id: playerId,
            })
          }
        })

        this.logger.info('Disconnected', playerId)
        this.logger.info(`${(this.game.world as ServerWorld).players.length - 1} total players connected`)
      })

      channel.on('command', (data) => {
        const bytes = Buffer.byteLength(data.toString())
        this.bandwidthTracker.recordReceived('server', bytes)

        this.bufferIncomingCommand(channel, data)
      })
    })

    this.game.onUpdate(delta => this.tick(delta))

    setInterval(() => {
      const { sent, received } = this.bandwidthTracker.getBandwidthUsage('server')
      this.logger.debug(`Client - Sent: ${sent} B, Received: ${received} B`)

      this.cpuTracker.log()

      this.bandwidthTracker.reset()
    }, 5000)
  }

  private bufferIncomingCommand(channel: ServerChannel, command: Data) {
    this.commandBuffer.push({
      playerId: channel.id!,
      ...(command) as object,
    })
  }

  private tick(delta: number) {
    this.runThroughBuffer()

    this.onTick(delta)
    this.stateSync()
  }

  static instance(): Server<GameObject> {
    return instance
  }

  /**
   * Send full state update to all clients.
   */
  private stateSync() {
    const trackedEntitiesForMarkingSyncd = new Map<string, NetworkedActor>() // Renamed to avoid confusion

    this.gameSocket.connectionsManager.connections.forEach((con, id) => {
      const player = this.game.world.entities.items.get(id!) as Player
      if (!player)
        return

      const entitiesToSend: GameObject[] = [] // Renamed for clarity

      // Create a temporary set of entities that should be tracked for this player in this tick
      const currentTickTrackedEntities = new Set<string>()

      this.game.world.entities.items.forEach((entity) => {
        const isWithinDistance = player.position.distanceTo(entity.position) < this.getStateSyncDistance()

        if (isWithinDistance) {
          // If within distance, always include it in the state update for this player
          entitiesToSend.push(entity)
          currentTickTrackedEntities.add(entity.id)

          // If this entity has "needsSync" set, or if it's new for this player,
          // we want to ensure its state is considered for marking as synced globally.
          // This ensures that actual movement flags are reset.
          if ((entity as NetworkedActor).needsSync || !player.trackedEntities.has(entity.id)) {
            if (!trackedEntitiesForMarkingSyncd.has(entity.id)) {
              trackedEntitiesForMarkingSyncd.set(entity.id, entity as NetworkedActor)
            }
          }
        }
        else {
          // If outside distance, ensure it's removed from trackedEntities for this player
          player.trackedEntities.delete(entity.id)
        }
      })

      // Update the player's trackedEntities to reflect the current tick's within-distance entities
      // This is crucial for correctly handling re-entry.
      player.trackedEntities = currentTickTrackedEntities

      const state = {
        entities: entitiesToSend, // Use the new array
        sequenceId: 0,
        type: ServerCommand.SV_STATE,
      }

      this.bandwidthTracker.recordSent('server', Buffer.byteLength(state.toString()))
      con.channel.emit(ServerCommand.SV_STATE, state)
    })

    // Mark entities as synced ONLY if they were actually sent to at least one client
    trackedEntitiesForMarkingSyncd.forEach(entity => entity.markSyncd())
  }

  /**
   * The distance the player should have to an object so it
   * is sent in the state update.
   */
  abstract getStateSyncDistance(): number

  private runThroughBuffer() {
    while (this.commandBuffer.length > 0) {
      const currentCommand = this.commandBuffer[0]

      this.onCommand(currentCommand, this.calculateDelta())

      this.commandBuffer.shift()
    }
  }

  private calculateDelta() {
    const currentTime = performance.now()
    const deltaTime = (currentTime - this.lastTime)

    return deltaTime
  }

  protected onTick(_delta: number): void { }

  onHttp(callback: (express: Express) => void) {
    this.onHttpCallback = callback
  }

  start() {
    this.logger.info('Starting @mavon/engine - Socket Server')
    this.gameSocket.listen(8081)

    this.startHttpServer()

    /**
     * Register any http functionality in your own server
     */
    if (this.onHttpCallback) {
      this.onHttpCallback(this.httpServer)
    }
  }

  private startHttpServer() {
    this.logger.info('Starting @mavon/engine - HTTP Server')
    this.httpServer.listen(8050)
    this.registerHealthEndpoint()

    this.logger.info('Visit game server status: http://localhost:8050/api/game/health')
  }

  private registerHealthEndpoint() {
    this.httpServer.get('/api/game/health', (_req, res) => {
      // eslint-disable-next-line ts/no-this-alias
      const server = this

      res.format({
        json() {
          res.json({
            serverTime: new Date(),
            uptime: Math.round(performance.now() / 1000),
            players: (server.game.world as ServerWorld).players.length,
            world: {
              entities: server.game.world.entities.length,
            },
            physics: {
              bodies: server.game.physicsWorld?.bodies.len(),
              colliders: server.game.physicsWorld?.colliders.len(),
            },
          })
        },
      })
    })
  }
}
