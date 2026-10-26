import type RAPIER from '@dimforge/rapier3d-compat'
import type { Data, GeckosServer, ServerChannel } from '@geckos.io/server'
import type { Express } from 'express'
import type winston from 'winston'
import type GameObject from '../../World/GameObject'
import type Player from '../Entities/Player'
import type NetworkedActor from '../NetworkedActor'
import type { ClientCommand, CommandPacket, IncomingClientCommandPacket } from './Commands'
import type { MetricsEndpointOptions } from './Http/HttpServer'
import type { LatencySimulatorOptions } from './LatencySimulator'
import type { ServerMetricsOptions, ServerMetricsSource } from './Stats/ServerMetrics'
import { Buffer } from 'node:buffer'
import geckos from '@geckos.io/server'
import BaseGame from '../../BaseGame'
import { ServerCommand } from './Commands'
import HttpServer from './Http/HttpServer'
import LatencySimulator from './LatencySimulator'
import ServerMetrics, { SERVER_BANDWIDTH_ID } from './Stats/ServerMetrics'
import ServerWorld from './World'

let instance: Server<GameObject>

export interface ServerOptions {
  latencySimulation?: LatencySimulatorOptions

  /** Port the geckos.io game socket listens on. Default 8081 */
  socketPort?: number

  /** Port the HTTP server listens on. Default 8050 */
  httpPort?: number

  metrics?: MetricsEndpointOptions & ServerMetricsOptions & {
    /** How often a CPU / bandwidth summary is logged, in ms. Default 5000 */
    logIntervalMs?: number
  }
}

export default abstract class Server<TClient extends GameObject> implements ServerMetricsSource {
  game: BaseGame

  private commandBuffer: IncomingClientCommandPacket<ClientCommand>[] = []

  gameSocket: GeckosServer
  protected logger: winston.Logger

  readonly metrics: ServerMetrics
  readonly http: HttpServer

  private onHttpCallback?: (httpServer: Express) => void
  private options: ServerOptions

  lastTime = performance.now()

  private latencySimulator?: LatencySimulator
  private commandsProcessedThisTick = 0
  private timers: ReturnType<typeof setInterval>[] = []

  protected abstract onConnection(channel: ServerChannel): TClient
  protected abstract onCommand(command: any, delta: number): void

  constructor(logger: winston.Logger, phyicsWorld?: RAPIER.World, options?: ServerOptions) {
    instance = this as unknown as Server<GameObject>

    this.game = new BaseGame(logger, phyicsWorld)
    this.game.world = new ServerWorld()

    this.gameSocket = geckos()
    this.logger = logger
    this.options = options ?? {}

    if (this.options.latencySimulation) {
      this.latencySimulator = new LatencySimulator(this.options.latencySimulation, this.logger)
    }

    this.metrics = new ServerMetrics(this, this.logger, this.options.metrics)
    this.http = new HttpServer(this.logger, this.metrics, {
      port: this.options.httpPort,
      metrics: this.options.metrics,
    })

    this.gameSocket.onConnection((channel) => {
      this.logger.info(`Connected: ${channel.id}`)

      const client = this.onConnection(channel)
      this.game.world.entities.items.set(client.id!.toString(), client)

      this.logger.info(`${(this.game.world as ServerWorld).players.length} total players connected`)

      channel.on('ping', () => {
        const pong = () => channel.emit('pong')

        if (this.latencySimulator) {
          this.latencySimulator.handle(pong)
        }
        else {
          pong()
        }
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
        const bytes = Buffer.byteLength(JSON.stringify(data))
        this.bandwidthTracker.recordReceived(SERVER_BANDWIDTH_ID, bytes)

        this.bufferIncomingCommand(channel, data)
      })
    })

    this.game.onUpdate(delta => this.tick(delta))
    this.game.on('tickComplete', (durationMs: number) => {
      this.metrics.tick.record(durationMs, this.commandsProcessedThisTick)
      this.commandsProcessedThisTick = 0
    })
  }

  get httpServer(): Express {
    return this.http.app
  }

  get bandwidthTracker() {
    return this.metrics.bandwidth
  }

  get latencySimulation() {
    return this.latencySimulator?.config
  }

  private bufferIncomingCommand(channel: ServerChannel, command: Data) {
    this.commandBuffer.push({
      playerId: channel.id!,
      ...(command) as CommandPacket<ClientCommand>,
    })
  }

  private tick(delta: number) {
    this.commandsProcessedThisTick += this.runThroughBuffer()

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

      this.bandwidthTracker.recordSent(SERVER_BANDWIDTH_ID, Buffer.byteLength(JSON.stringify(state)))

      const SendState = () => con.channel.emit(ServerCommand.SV_STATE, state)

      if (this.latencySimulator) {
        this.latencySimulator.handle(SendState)
      }
      else {
        SendState()
      }
    })

    // Mark entities as synced ONLY if they were actually sent to at least one client
    trackedEntitiesForMarkingSyncd.forEach(entity => entity.markSyncd())
  }

  /**
   * The distance the player should have to an object so it
   * is sent in the state update.
   */
  abstract getStateSyncDistance(): number

  /**
   * Process every buffered command and return how many were processed.
   */
  private runThroughBuffer(): number {
    /**
     * Due to network latency packets could come in different orders. First step is sort by sequence Id
     *
     * This currently will move recently connected clients to the
     * front of the tick to be processed. Not really an issue at the moment but if it does
     * turn out to be an issue then we need to sort the packets by playerId too.
     *
     * TODO fix ordering to sort packets only for player ids.
     * If in an FPS player1 shoots first but this sorting puts player2 shot to be
     * ticked over first because their sequenceId is lower its not really fair
     */
    this.commandBuffer.sort((a, b) => a.sequenceId! - b.sequenceId!)

    const commands = this.commandBuffer
    this.commandBuffer = []

    const delta = this.calculateDelta()

    for (const currentCommand of commands) {
      const process = () => {
        // The player may have disconnected while the latency simulator held the command back
        const player = this.game.world.entities.items.get(currentCommand.playerId!) as Player | undefined
        if (!player)
          return

        this.onCommand(currentCommand, delta)

        /**
         * Update the players lastProcessedSequenceId after the command has executed.
         * Simulated jitter can complete commands out of order so never move it backwards.
         */
        if (currentCommand.sequenceId! > player.lastProcessedSequenceId)
          player.updateLastProcessedSequenceId(currentCommand.sequenceId!)
      }

      if (this.latencySimulator) {
        this.latencySimulator.handle(process)
      }
      else {
        process()
      }
    }

    this.lastTime = performance.now()

    return commands.length
  }

  /**
   * Ms since the command buffer was last processed
   */
  private calculateDelta() {
    return performance.now() - this.lastTime
  }

  protected onTick(_delta: number): void { }

  onHttp(callback: (express: Express) => void) {
    this.onHttpCallback = callback
  }

  start() {
    this.logger.info('Starting @mavon/engine - Socket Server')
    this.gameSocket.listen(this.options.socketPort ?? 8081)

    this.http.start()
    this.startMetrics()

    /**
     * Register any http functionality in your own server
     */
    if (this.onHttpCallback) {
      this.onHttpCallback(this.httpServer)
    }
  }

  /**
   * Stop the metric sampling and logging timers
   */
  stop() {
    this.timers.forEach(timer => clearInterval(timer))
    this.timers = []
  }

  private startMetrics() {
    const logIntervalMs = this.options.metrics?.logIntervalMs ?? 5000

    this.timers.push(setInterval(() => this.metrics.sample(), this.metrics.sampleIntervalMs))

    this.timers.push(setInterval(() => {
      const { sent, received } = this.bandwidthTracker.getTotalSince(logIntervalMs)
      this.logger.debug(`Client - Sent: ${sent} B, Received: ${received} B`)

      this.metrics.cpu.log()
    }, logIntervalMs))
  }
}
