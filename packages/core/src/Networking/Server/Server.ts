import type RAPIER from '@dimforge/rapier3d-compat'
import type { Data, GeckosServer, ServerChannel } from '@geckos.io/server'
import type { Express } from 'express'
import type { Kysely } from 'kysely'
import type { FSWatcher } from 'node:fs'
import type { IncomingMessage } from 'node:http'
import type winston from 'winston'
import type { Notifiable, NotificationLike, Notifier } from '../../Notifications/Notifiable'
import type { LoadedPlugin, ServerPlugin, ServerPluginContext, ServerPluginInfo } from '../../Plugins/types'
import type { QueueOptions } from '../../Queue/Queue'
import type GameScene from '../../Scene/GameScene'
import type GameObject from '../../World/GameObject'
import type { NetDebugSource, SyncSnapshot, SyncStateSummary } from '../Debug/sync'
import type { AuthorizeResult, Identity } from '../identity'
import type NetworkedActor from '../NetworkedActor'
import type { AdminPanelOptions } from './Admin/AdminPanel'
import type { CommandPacket, IncomingClientCommandPacket, StatePacket } from './Commands'
import type { ClientOptions } from './Http/ClientMiddleware'
import type { MetricsEndpointOptions } from './Http/HttpServer'
import type { LatencySimulatorOptions } from './LatencySimulator'
import type { DatabaseSource } from './Stats/DatabaseInspector'
import type { ServerMetricsOptions, ServerMetricsSource } from './Stats/ServerMetrics'
import type { WorldInspectorSource } from './Stats/WorldInspector'
import { Buffer } from 'node:buffer'
import { watch } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import geckos from '@geckos.io/server'
import BaseGame from '../../BaseGame'
import { currentNotifier, setNotifier } from '../../Notifications/Notifiable'
import { hasMigrations, runPluginMigrations } from '../../Plugins/Database/migrate'
import { tableName } from '../../Plugins/Database/tables'
import { loadServerPlugins } from '../../Plugins/loadServerPlugins'
import PluginHost from '../../Plugins/PluginHost'
import { APP_URL_ENV, parseAppUrl, pluginInfos, readConfig } from '../../Plugins/ProjectConfig'
import { publishedFile } from '../../Plugins/publish'
import DatabaseQueueDriver, { QUEUE_PACKAGE, queueMigrations } from '../../Queue/drivers/DatabaseQueueDriver'
import Queue from '../../Queue/Queue'
import { readSceneFile, sceneFilePath, sceneNameOf } from '../../Scene/loadSceneFile'
import { registerSceneObject, sceneObjectKey } from '../../Scene/SceneObjectRegistry'
import NetRecorder from '../Debug/NetRecorder'
import { rememberJson, tapMessages } from '../Debug/tap'
import Player from '../Entities/Player'
import { accountOf, identityOf, isIdentity } from '../identity'
import NetworkedGameObject from '../NetworkedGameObject'
import { ClientCommand, ServerCommand } from './Commands'
import HttpServer, { ADMIN_TOKEN_ENV } from './Http/HttpServer'
import LatencySimulator from './LatencySimulator'
import DatabaseInspector from './Stats/DatabaseInspector'
import LogBuffer from './Stats/LogBuffer'
import RequestLog from './Stats/RequestLog'
import ServerMetrics, { SERVER_BANDWIDTH_ID } from './Stats/ServerMetrics'
import WorldInspector, { devEndpointsEnabled } from './Stats/WorldInspector'
import ServerWorld from './World'

let instance: Server<GameObject>

export interface ServerOptions {
  latencySimulation?: LatencySimulatorOptions

  /**
   * Separate port for the geckos.io game socket, or false for none.
   * Defaults to none when the HTTP server serves the client, since the socket is reachable there, and 8081 otherwise.
   */
  socketPort?: number | false

  /** Port the HTTP server listens on. Default 8050 */
  httpPort?: number

  /**
   * The admin token of this server, also read from `MAVONENGINE_ADMIN_TOKEN`. It is what `server.http.requireAdmin`
   * and `ctx.requireAdmin` of plugins ask for, as `Authorization: Bearer <token>`, and the metrics endpoints take it too.
   * Without one, admin routes only answer requests from localhost.
   */
  adminToken?: string

  /**
   * The admin panel under `/admin`: a layout with a sidebar that the engine and plugins add pages to. Behind the admin
   * token, as the password of the browser's login prompt. Off in production until the server has a token
   */
  admin?: AdminPanelOptions

  /**
   * Serve the game client from the HTTP server: the source through Vite when `dev` is set, the built files otherwise.
   * The game socket is then also reachable on the HTTP port, so the client needs no second origin.
   */
  client?: ClientOptions

  metrics?: MetricsEndpointOptions & ServerMetricsOptions & {
    /** How often a CPU / bandwidth summary is logged, in ms. Default 5000 */
    logIntervalMs?: number

    /** How many recent log entries are kept for GET /api/game/logs. 0 turns it off. Default 500 */
    logBufferSize?: number

    /** How many recent HTTP requests are kept for GET /api/game/requests. 0 turns it off. Default 500 */
    requestLogSize?: number
  }

  /**
   * Engine plugins to run. With `{ root }` the plugins enabled in `<root>/mavonengine.json` are imported
   * when the server starts; or pass plugin objects directly.
   */
  plugins?: (ServerPlugin | LoadedPlugin<ServerPlugin>)[] | { root: string }

  /**
   * Stop gracefully when the process gets SIGINT (Ctrl+C) or SIGTERM (a deploy, `docker stop`, `mavonengine dev`
   * restarting it), then exit: plugins' `destroy()` runs and the database is closed. Default true. Turn it off
   * when the game handles these signals itself, and call `stop()` there.
   * Windows has no SIGTERM: a process killed there stops without this.
   */
  stopOnSignals?: boolean

  /**
   * Package of the database plugin to use, when more than one is enabled. Defaults to `database` in mavonengine.json,
   * else the first database plugin
   */
  database?: string

  /**
   * Package of the auth plugin to use, when more than one is enabled. Defaults to `auth` in mavonengine.json,
   * else the first auth plugin
   */
  auth?: string

  /**
   * Package of the notifications plugin to use, when more than one is enabled. Defaults to `notifications` in
   * mavonengine.json, else the first notifications plugin
   */
  notifications?: string

  /**
   * Where the game is, e.g. `https://mygame.com`, for links that leave it, like in mails. Defaults to `appUrl` in
   * mavonengine.json. `MAVONENGINE_APP_URL` overrides both
   */
  appUrl?: string

  /** The game's name, e.g. in mails. Defaults to `appName` in mavonengine.json */
  appName?: string

  /**
   * The job queue, `server.queue`. Its jobs are kept in the database when the project has a database plugin, else in
   * memory, and run in this process
   */
  queue?: QueueOptions

  /**
   * Project root, the directory with mavonengine.json and `scenes/`. Scene names given to `openScene()` are looked up there.
   * Defaults to `plugins.root`
   */
  root?: string
}

export interface OpenSceneOptions {
  /**
   * Load the scene again whenever its file changes, e.g. when the editor saves it.
   * Default: on while the client is served through Vite (`client.dev`)
   */
  watch?: boolean
}

function toLoadedPlugin(plugin: ServerPlugin | LoadedPlugin<ServerPlugin>, index: number): LoadedPlugin<ServerPlugin> {
  if ('plugin' in plugin && 'package' in plugin)
    return plugin as LoadedPlugin<ServerPlugin>

  const bare = plugin as ServerPlugin
  return { package: bare.name ?? `plugin-${index}`, options: {}, plugin: bare }
}

/** How long the servers get to stop after SIGINT or SIGTERM before the process exits anyway. Below the 3s `mavonengine dev` waits */
export const SIGNAL_STOP_TIMEOUT_MS = 2500

const STOP_SIGNALS = ['SIGINT', 'SIGTERM'] as const

/** How many entity ids a sync_enter / sync_leave event lists before it only counts them */
const MAX_SYNC_EVENT_IDS = 20

const vec = ({ x, y, z }: { x: number, y: number, z: number }) => ({ x, y, z })

export default abstract class Server<TClient extends GameObject> implements ServerMetricsSource, WorldInspectorSource, NetDebugSource, DatabaseSource {
  game: BaseGame

  private commandBuffer: IncomingClientCommandPacket<ClientCommand>[] = []

  gameSocket: GeckosServer
  protected logger: winston.Logger

  readonly metrics: ServerMetrics
  readonly http: HttpServer
  readonly logs?: LogBuffer
  readonly requests?: RequestLog

  /**
   * The last packets and network events, for the dev tools (GET /api/game/dev/net/*).
   * Records outside production only; set `net.enabled` to change that.
   */
  readonly net = new NetRecorder({
    enabled: devEndpointsEnabled(),
  })

  /** Number of the tick being simulated. Stamped on every sv_state, so clients and tools can tell them apart */
  tickCount = 0

  /** Tick each entity was last sent in, kept while `net` records */
  private lastSentTick = new Map<string, number>()
  /** The last sv_state sent to each channel, kept while `net` records */
  private lastStates = new Map<string, SyncStateSummary>()
  /** The transport's byte counters per channel, as they were when bandwidth was last recorded */
  private transportBytes = new Map<string, { sent: number, received: number }>()

  private onHttpCallback?: (httpServer: Express) => void
  private options: ServerOptions

  lastTime = performance.now()

  private latencySimulator?: LatencySimulator
  private commandsProcessedThisTick = 0
  private dashboardWatching = false
  private timers: ReturnType<typeof setInterval>[] = []
  private sceneWatcher?: FSWatcher

  /** File of the scene last opened with `openScene()` */
  activeSceneFile?: string

  /**
   * Channels of clients running the editor. They have no player in the world, so they aren't counted
   * or simulated as players, and are sent every entity in the world.
   */
  readonly editorChannels = new Set<string>()

  /** The running plugins, once `start()` has loaded them */
  plugins?: PluginHost<ServerPlugin, ServerPluginContext>

  private database?: { db: Kysely<any>, provider: string }

  /**
   * Jobs to run in the background: `server.queue.dispatch(new MyJob(data))`. Jobs can be dispatched before `start()`;
   * they start running once it is done, in the database when the project has one.
   */
  readonly queue: Queue

  /**
   * Set when the project has an auth plugin. Without `provider` (the plugin was meant to run but doesn't), every
   * client is turned away
   */
  private auth?: { provider?: string }

  /** Package of the notifications plugin, and what this server set as the process's notifier */
  private notifications?: { provider?: string, notifier: Notifier, warned?: boolean }

  protected abstract onConnection(channel: ServerChannel): TClient
  protected abstract onCommand(command: any, delta: number): void

  constructor(logger: winston.Logger, phyicsWorld?: RAPIER.World, options?: ServerOptions) {
    instance = this as unknown as Server<GameObject>

    // Attached first so the boot banner is captured too
    const logBufferSize = options?.metrics?.logBufferSize ?? 500
    if (logBufferSize > 0) {
      this.logs = new LogBuffer(logBufferSize)
      logger.add(this.logs.transport)
    }

    this.game = new BaseGame(logger, phyicsWorld)
    this.game.world = new ServerWorld()

    // Asked for every connection, before it gets a channel: what is returned becomes the channel's userData
    this.gameSocket = geckos({
      authorization: (authorization, request) => this.authorizeConnection(authorization, request),
    })
    this.logger = logger
    this.options = options ?? {}
    this.queue = new Queue(logger, this.options.queue)

    if (this.options.latencySimulation) {
      this.latencySimulator = new LatencySimulator(this.options.latencySimulation, this.logger)
    }

    const requestLogSize = this.options.metrics?.requestLogSize ?? 500
    if (requestLogSize > 0)
      this.requests = new RequestLog(requestLogSize)

    this.metrics = new ServerMetrics(this, this.logger, this.options.metrics)
    this.http = new HttpServer(this.logger, this.metrics, {
      port: this.options.httpPort,
      adminToken: this.options.adminToken ?? process.env[ADMIN_TOKEN_ENV],
      metrics: this.options.metrics,
      logs: this.logs,
      requests: this.requests,
      client: this.options.client,
      inspector: new WorldInspector(this),
      net: this,
      plugins: () => this.pluginInfos(),
      database: new DatabaseInspector(this),
      admin: this.options.admin,
      appName: () => this.appName,
    })

    this.gameSocket.onConnection((channel) => {
      const identity = identityOf(channel)
      this.logger.info(`Connected: ${channel.id}${identity
        ? ` as ${identity.name ?? identity.id} (${identity.id})`
        : ''}`)

      // Before anything is sent or listened to, so the game's own messages are recorded too
      this.tapChannel(channel)

      const client = this.onConnection(channel)
      if (client instanceof Player)
        client.channel = channel
      this.game.world.entities.items.set(client.id!.toString(), client)

      this.logger.info(`${(this.game.world as ServerWorld).players.length} total players connected`)

      this.plugins?.run('onConnection', channel, client)

      channel.on(ClientCommand.CL_EDITOR, () => this.attachEditor(channel))

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

        this.net.event('disconnect', { peer: playerId })
        this.lastStates.delete(playerId)
        // Count what it sent and received since the last sample before its counters are gone
        this.recordTransportBytes(channel)
        this.transportBytes.delete(playerId)

        if (this.editorChannels.delete(playerId)) {
          this.logger.info(`Editor disconnected: ${playerId}`)
          return
        }

        const disconnectedPlayer = BaseGame.instance().world.entities.items.get(playerId) as Player

        this.plugins?.run('onDisconnect', channel)

        if (!disconnectedPlayer)
          return

        // Flag only: the world calls destroy() when it collects the entity on the next tick
        disconnectedPlayer.garbageCollect = true

        // Only notify players within visibility radius
        this.gameSocket.connectionsManager.connections.forEach((conn, connId) => {
          if (connId === playerId)
            return

          if (this.editorChannels.has(connId!)) {
            conn.channel.emit(ServerCommand.SV_REMOVE_ENTITY, { id: playerId })
            return
          }

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

      channel.on('command', data => this.bufferIncomingCommand(channel, data))
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

  /**
   * Add the bytes a channel sent and received since it was last looked at to the bandwidth tracker.
   * Read from the WebRTC connection's own counters, so every message counts and none is serialized just to be measured.
   */
  private recordTransportBytes(channel: ServerChannel) {
    const peer = channel.webrtcConnection?.peerConnection
    if (!peer)
      return

    let sent: number
    let received: number
    // node-datachannel throws once the peer connection is closed
    try {
      sent = peer.bytesSent()
      received = peer.bytesReceived()
    }
    catch {
      return
    }

    const before = this.transportBytes.get(channel.id!) ?? { sent: 0, received: 0 }
    this.transportBytes.set(channel.id!, { sent, received })
    this.bandwidthTracker.recordSent(SERVER_BANDWIDTH_ID, Math.max(0, sent - before.sent))
    this.bandwidthTracker.recordReceived(SERVER_BANDWIDTH_ID, Math.max(0, received - before.received))
  }

  /**
   * Close the current sampling window of the metrics, with the bytes every connection moved in it
   */
  private sampleMetrics() {
    this.gameSocket.connectionsManager.connections.forEach(con => this.recordTransportBytes(con.channel))
    this.metrics.sample()
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

  /**
   * Record what this channel sends and receives, and what the transport drops.
   * Channels that connected while `net` was off stay unrecorded.
   */
  private tapChannel(channel: ServerChannel) {
    if (!this.net.enabled)
      return

    const peer = channel.id!
    tapMessages(channel, '_emit', 'out', this.net, peer)
    tapMessages((channel as unknown as { eventEmitter?: unknown }).eventEmitter, 'emit', 'in', this.net, peer)

    if (typeof channel.onDrop === 'function') {
      channel.onDrop((drop) => {
        this.net.event('dropped', {
          peer,
          info: { reason: (drop as { reason?: string }).reason, message: drop.event },
        })
      })
    }

    this.net.event('connect', { peer })
  }

  private tick(delta: number) {
    this.tickCount++
    this.commandsProcessedThisTick += this.runThroughBuffer()

    this.onTick(delta)
    this.plugins?.run('tick', delta)
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
      if (this.editorChannels.has(id!)) {
        this.sendState(con.channel, [
          ...this.game.world.entities.items.values(),
        ].filter(entity => this.isSynced(entity)), null)
        return
      }

      const player = this.game.world.entities.items.get(id!) as Player
      if (!player)
        return

      const entitiesToSend: GameObject[] = [] // Renamed for clarity

      // Create a temporary set of entities that should be tracked for this player in this tick
      const currentTickTrackedEntities = new Set<string>()
      // Copied, because entities out of range are deleted from the player's set below
      const previouslyTracked = this.net.enabled
        ? new Set(player.trackedEntities)
        : undefined

      this.game.world.entities.items.forEach((entity) => {
        if (!this.isSynced(entity))
          return

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

      if (previouslyTracked)
        this.recordSyncChanges(id!, previouslyTracked, currentTickTrackedEntities)

      // Update the player's trackedEntities to reflect the current tick's within-distance entities
      // This is crucial for correctly handling re-entry.
      player.trackedEntities = currentTickTrackedEntities

      this.sendState(con.channel, entitiesToSend, player.lastProcessedSequenceId)
    })

    // Mark entities as synced ONLY if they were actually sent to at least one client
    trackedEntitiesForMarkingSyncd.forEach(entity => entity.markSyncd())
  }

  /**
   * Scene objects are map data the clients load from the scene file themselves (or get in their own packets),
   * so they are only sent in SV_STATE when they are networked entities
   */
  private isSynced(entity: GameObject): boolean {
    return !this.game.activeScene?.entryOf(entity) || entity instanceof NetworkedGameObject
  }

  /**
   * Which entities came into a player's sync distance this tick and which left it, as timeline events
   */
  private recordSyncChanges(peer: string, before: Set<string>, now: Set<string>) {
    const entered = [...now].filter(id => !before.has(id))
    const left = [...before].filter(id => !now.has(id))

    if (entered.length) {
      this.net.event('sync_enter', {
        peer,
        tick: this.tickCount,
        info: {
          count: entered.length,
          entities: entered.slice(0, MAX_SYNC_EVENT_IDS),
        },
      })
    }
    if (left.length) {
      this.net.event('sync_leave', {
        peer,
        tick: this.tickCount,
        info: {
          count: left.length,
          entities: left.slice(0, MAX_SYNC_EVENT_IDS),
        },
      })
    }
  }

  /**
   * Send `entities` to one client. `ack` is the sequence id of the last input of this client that was processed,
   * null for a client without a player (the editor).
   */
  private sendState(channel: ServerChannel, entities: GameObject[], ack: number | null) {
    const state: StatePacket<GameObject> = {
      entities,
      sequenceId: 0,
      type: ServerCommand.SV_STATE,
      tick: this.tickCount,
      serverTime: Date.now(),
      ack,
    }

    // Serialized here for the dev tools only: geckos.io serializes the state itself when it sends it
    if (this.net.enabled) {
      const json = JSON.stringify(state)
      // The tap on the channel records the packet when it is really sent, after any simulated latency
      rememberJson(state, json)
      this.lastStates.set(channel.id!, {
        tick: state.tick,
        bytes: Buffer.byteLength(json),
        entities: entities.length,
      })
      for (const entity of entities)
        this.lastSentTick.set(entity.id, state.tick)
    }

    const SendState = () => channel.emit(ServerCommand.SV_STATE, state)

    if (this.latencySimulator) {
      this.latencySimulator.handle(SendState)
    }
    else {
      SendState()
    }
  }

  /**
   * Who is sent what right now: every synced entity with how many players track it, and each player's last state update
   */
  syncSnapshot(): SyncSnapshot {
    const world = this.game.world as ServerWorld
    const players = world.players
    const trackedBy = new Map<string, number>()
    for (const player of players) {
      for (const id of player.trackedEntities)
        trackedBy.set(id, (trackedBy.get(id) ?? 0) + 1)
    }

    let syncDistance: number | null = null
    try {
      syncDistance = this.getStateSyncDistance()
    }
    catch {
      // The game's server doesn't implement it
    }

    const entities = [
      ...world.entities.items.values(),
    ].filter(entity => this.isSynced(entity))

    // Forget entities that left the world
    const ids = new Set(entities.map(entity => entity.id))
    for (const id of this.lastSentTick.keys()) {
      if (!ids.has(id))
        this.lastSentTick.delete(id)
    }

    return {
      tick: this.tickCount,
      serverTime: Date.now(),
      tickRate: this.game.tickRate,
      syncDistance,
      players: players.map(player => ({
        id: player.id,
        displayName: player.displayName,
        position: vec(player.position),
        ack: player.lastProcessedSequenceId,
        tracked: [...player.trackedEntities],
        lastState: this.lastStates.get(player.id) ?? null,
        account: accountOf(player.identity),
      })),
      editors: [...this.editorChannels],
      entities: entities.map(entity => ({
        id: entity.id,
        type: (entity as { $typeName?: string }).$typeName ?? entity.constructor.name,
        position: vec(entity.position),
        rotation: vec(entity.rotation),
        scale: vec(entity.scale),
        player: entity instanceof Player,
        needsSync: (entity as Partial<NetworkedActor>).needsSync === true,
        trackedBy: trackedBy.get(entity.id) ?? 0,
        lastSentTick: this.lastSentTick.get(entity.id) ?? null,
      })),
    }
  }

  /**
   * A client booted the editor: take its player out of the world, tell the other players it is gone,
   * and from now on send it the whole world state.
   */
  private attachEditor(channel: ServerChannel) {
    const id = channel.id!
    // An editor is sent every entity in the world, however far away: in production that would let any player see
    // the whole map. The editor only runs in dev, so a production server ignores the request
    if (!devEndpointsEnabled()) {
      const identity = identityOf(channel)
      this.logger.warn(`${id}${identity
        ? ` (${identity.name ?? identity.id})`
        : ''} asked to attach the editor, which a production server doesn't allow: ignored`)
      this.net.event('editor_refused', { peer: id })
      return
    }
    if (this.editorChannels.has(id))
      return
    this.editorChannels.add(id)
    this.net.event('editor_attached', { peer: id })

    const player = this.game.world.entities.items.get(id)
    if (player) {
      this.game.world.entities.items.delete(id)
      player.destroy()

      this.gameSocket.connectionsManager.connections.forEach((conn, connId) => {
        if (connId !== id)
          conn.channel.emit(ServerCommand.SV_REMOVE_ENTITY, { id })
      })
    }

    this.logger.info(`${id} opened the editor, it is no longer a player. ${(this.game.world as ServerWorld).players.length} total players connected`)
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

  /**
   * The database, a Kysely instance (https://kysely.dev) from the project's database plugin, such as `@mavonengine/sqlite`.
   * Undefined without one, and until `start()` picked it. The game's own tables should not start with a plugin's prefix
   * (`chat_`, …): name them e.g. `game_scores`.
   */
  get db(): Kysely<any> | undefined {
    return this.database?.db
  }

  /** Package of the database plugin in use */
  get databaseProvider(): string | undefined {
    return this.database?.provider
  }

  /** Packages of the project's plugins, to tell whose a table in the database is */
  databasePlugins(): string[] {
    return [
      ...this.pluginInfos().map(info => info.package),
      QUEUE_PACKAGE,
    ]
  }

  /**
   * Start the HTTP server and the game socket. With `options.plugins.root` the plugins are imported first, and
   * plugins' database migrations run before their `setup()`, so wait for the returned promise before relying on them.
   * Without either, everything starts synchronously.
   */
  start(): Promise<void> {
    const plugins = this.options.plugins
    if (plugins && !Array.isArray(plugins)) {
      return loadServerPlugins(plugins.root).then(({ plugins: loaded, warnings, incompatible }) => {
        warnings.forEach(warning => this.logger.warn(`Plugin skipped: ${warning}`))
        incompatible.forEach(warning => this.logger.warn(`Plugin loaded anyway: ${warning}`))
        return this.boot(loaded)
      })
    }

    return this.boot((plugins ?? []).map(toLoadedPlugin))
  }

  private boot(loaded: LoadedPlugin<ServerPlugin>[]): Promise<void> {
    const host = this.createPluginHost(loaded)
    this.openDatabase(host)
    this.openQueue()
    // Decided before the migrations, which turn off a plugin whose migration fails: an auth plugin that drops out
    // that way leaves the server turning everyone away instead of letting everyone in
    if (this.expectsAuth(host))
      this.auth = {}

    const migrating = host.plugins.filter(plugin => hasMigrations(plugin.plugin))
    if (!this.database) {
      for (const plugin of migrating)
        this.logger.warn(`Plugin ${PluginHost.label(plugin)} has database migrations, but the project has no database plugin such as @mavonengine/sqlite: it runs without a database`)
    }

    if (!this.database || migrating.length === 0) {
      this.startServer(host)
      return Promise.resolve()
    }

    return this.migrate(host, migrating, this.database.db).then(() => this.startServer(host))
  }

  private createPluginHost(plugins: LoadedPlugin<ServerPlugin>[]) {
    // eslint-disable-next-line ts/no-this-alias
    const server = this
    const host: PluginHost<ServerPlugin, ServerPluginContext> = new PluginHost<ServerPlugin, ServerPluginContext>(plugins, loaded => ({
      package: loaded.package,
      options: loaded.options,
      game: this.game,
      logger: this.logger,
      server: this as unknown as Server<GameObject>,
      projectRoot: this.projectRoot,
      get appUrl() {
        return server.appUrl
      },
      get appName() {
        return server.appName
      },
      publishedFile: (path) => {
        const root = this.projectRoot
        return root
          ? publishedFile(root, loaded.package, path)
          : undefined
      },
      requireAdmin: this.http.requireAdmin,
      adminToken: this.http.adminToken,
      admin: this.http.admin.forPlugin(loaded.package),
      get db() {
        return server.db
      },
      queue: this.queue,
      table: name => tableName(loaded.package, name),
      identity: identityOf,
      plugin: (pkg: string) => host.api(pkg) as any,
      registerSceneObject: (definition) => {
        registerSceneObject({ ...definition, plugin: loaded.package })
        return sceneObjectKey({ ...definition, plugin: loaded.package })
      },
    }), this.logger, 'server')
    return host
  }

  /**
   * Ask the project's database plugin for the database. Which one: `options.database`, else `database` in mavonengine.json,
   * else the first that is enabled.
   */
  private openDatabase(host: PluginHost<ServerPlugin, ServerPluginContext>) {
    const providers = host.plugins.filter(plugin => typeof plugin.plugin.database === 'function')
    const provider = this.pickProvider(providers, this.options.database ?? this.configured('database'), 'database', 'so the server has no database')
    if (!provider)
      return

    const db = host.callOn(provider.package, 'database')
    if (!db) {
      this.logger.error(`Database plugin ${PluginHost.label(provider)} gave no database, so the server has none`)
      return
    }

    this.database = { db, provider: provider.package }
    this.logger.info(`Database: ${PluginHost.label(provider)}`)
  }

  /**
   * Keep the queue's jobs in the database when there is one, once its tables are migrated. Doesn't hold up the start:
   * jobs dispatched meanwhile wait for it. When the migration fails the queue stays in memory.
   */
  private openQueue() {
    const wanted = this.options.queue?.driver
    if (wanted === 'memory')
      return

    const database = this.database
    if (!database) {
      if (wanted === 'database')
        this.logger.warn('The queue should keep its jobs in the database, but the project has no database plugin such as @mavonengine/sqlite: keeping them in memory')
      return
    }

    void this.queue.use(runPluginMigrations(database.db, QUEUE_PACKAGE, queueMigrations).then(
      (applied) => {
        if (applied.length)
          this.logger.info(`Queue: ran migrations ${applied.join(', ')}`)
        return new DatabaseQueueDriver(database.db)
      },
      (err: Error) => {
        this.logger.error(`Queue: ${err.message}. Keeping its jobs in memory, so they are lost when the server stops`)
        return undefined
      },
    ))
  }

  /** Auth plugins among `plugins` */
  private static authProviders(plugins: LoadedPlugin<ServerPlugin>[]) {
    return plugins.filter(plugin => typeof plugin.plugin.authorize === 'function')
  }

  /** Whether the project means to check who connects: it has an auth plugin, or names one */
  private expectsAuth(host: PluginHost<ServerPlugin, ServerPluginContext>): boolean {
    return !!(this.options.auth ?? this.configured('auth')) || Server.authProviders(host.plugins).length > 0
  }

  /**
   * Pick the auth plugin that decides who may connect: `options.auth`, else `auth` in mavonengine.json, else the first
   * that is enabled. Without the one the project expects, `this.auth` stays without a provider and everyone is turned away.
   */
  private openAuth(host: PluginHost<ServerPlugin, ServerPluginContext>) {
    if (!this.auth)
      return

    const providers = Server.authProviders(host.plugins)
    const provider = this.pickProvider(providers, this.options.auth ?? this.configured('auth'), 'auth', 'so every client is turned away')
    if (!provider) {
      if (providers.length === 0)
        this.logger.error('The project\'s auth plugin is not running, so every client is turned away')
      return
    }

    this.auth = { provider: provider.package }
    this.logger.info(`Auth: ${PluginHost.label(provider)}`)
  }

  /**
   * The provider of a database or auth among `providers`: the one named `wanted`, else the first. Undefined, with an
   * error, when `wanted` isn't among them, and without one when there are none.
   */
  private pickProvider(providers: LoadedPlugin<ServerPlugin>[], wanted: string | undefined, kind: 'database' | 'auth' | 'notifications', withoutIt: string) {
    if (providers.length === 0)
      return undefined

    const title = { database: 'Database', auth: 'Auth', notifications: 'Notifications' }[kind]
    if (wanted) {
      const match = providers.find(plugin => plugin.package === wanted)
      if (!match)
        this.logger.error(`${title} plugin ${wanted} is not running, ${withoutIt}. ${title} plugins running: ${providers.map(plugin => plugin.package).join(', ')}`)
      return match
    }

    if (providers.length > 1)
      this.logger.warn(`More than one ${kind} plugin is enabled (${providers.map(plugin => plugin.package).join(', ')}), using ${providers[0].package}. Set "${kind}" in mavonengine.json to pick one`)
    return providers[0]
  }

  /**
   * geckos' authorization callback: asks the auth plugin whether the client may connect, and returns what geckos
   * makes of it: the userData of the channel, true to let it in without, or the HTTP status to turn it away with
   */
  private async authorizeConnection(authorization: string | undefined, request: IncomingMessage): Promise<Identity | true | number> {
    const auth = this.auth
    if (!auth)
      return true

    const provider = auth.provider && this.plugins?.plugins.find(plugin => plugin.package === auth.provider)
    const ctx = provider && this.plugins?.contextOf(provider.package)
    if (!provider || !ctx)
      return 503

    let result: AuthorizeResult
    try {
      // Called directly rather than through the plugin host, which turns a hook off when it throws: one bad header
      // must not lock every client out, nor let them in
      result = await provider.plugin.authorize!(authorization, request, ctx)
    }
    catch (err) {
      this.logger.error(`Auth plugin ${PluginHost.label(provider)} failed in authorize(), turning the client away: ${(err as Error)?.stack ?? err}`)
      return 500
    }

    if (result === true || isIdentity(result))
      return result
    if (result === false)
      return 401
    if (typeof result === 'number' && Number.isInteger(result) && result >= 400 && result < 600)
      return result

    this.logger.error(`Auth plugin ${PluginHost.label(provider)} returned ${JSON.stringify(result)} from authorize(), which is no identity, boolean or HTTP status from 400 to 599: turning the client away`)
    return 500
  }

  /**
   * Pick the notifications plugin, and make this server the one `notify()` and `player.notify()` send through.
   * Without one it still is, so they say so in this server's log.
   */
  private openNotifications(host: PluginHost<ServerPlugin, ServerPluginContext>) {
    const providers = host.plugins.filter(plugin => typeof plugin.plugin.notify === 'function')
    const provider = this.pickProvider(providers, this.options.notifications ?? this.configured('notifications'), 'notifications', 'so no notifications are sent')
    const notifier: Notifier = (to, notification) => this.sendNotification(to, notification)
    this.notifications = { provider: provider?.package, notifier }
    setNotifier(notifier)
    if (provider)
      this.logger.info(`Notifications: ${PluginHost.label(provider)}`)
  }

  private async sendNotification(to: Notifiable[], notification: NotificationLike) {
    const notifications = this.notifications
    const provider = notifications?.provider && this.plugins?.plugins.find(plugin => plugin.package === notifications.provider)
    const ctx = provider && this.plugins?.contextOf(provider.package)
    if (!provider || !ctx) {
      if (notifications && !notifications.warned) {
        notifications.warned = true
        this.logger.warn('notify(): no notifications are sent, as the project has no notifications plugin such as @mavonengine/notifications')
      }
      return
    }

    // Called directly, like authorize(): a notification that can't be sent is the caller's to hear of, and must not
    // turn notifications off for everyone
    await provider.plugin.notify!(to, notification, ctx)
  }

  /** Package of the notifications plugin `notify()` sends through */
  get notificationsProvider(): string | undefined {
    return this.notifications?.provider
  }

  /** Package of the auth plugin that decides who may connect */
  get authProvider(): string | undefined {
    return this.auth?.provider
  }

  /** `database` or `auth` from mavonengine.json */
  /**
   * Where the game is, for links that leave it: `MAVONENGINE_APP_URL`, else the `appUrl` option, else `appUrl` in
   * mavonengine.json. Only http(s) URLs, without a trailing slash. Undefined when none is set
   */
  get appUrl(): string | undefined {
    return parseAppUrl(process.env[APP_URL_ENV]) ?? parseAppUrl(this.options.appUrl) ?? parseAppUrl(this.configured('appUrl'))
  }

  /** The game's name: the `appName` option, else `appName` in mavonengine.json. Undefined when none is set */
  get appName(): string | undefined {
    const name = this.options.appName?.trim() || this.configured('appName')?.trim()
    return name || undefined
  }

  private configured(key: 'database' | 'auth' | 'notifications' | 'appUrl' | 'appName'): string | undefined {
    const root = this.projectRoot
    if (!root)
      return undefined

    try {
      const value = readConfig(root)[key]
      return typeof value === 'string' && value
        ? value
        : undefined
    }
    catch {
      // An unreadable mavonengine.json was already reported when the plugins were loaded
      return undefined
    }
  }

  /**
   * Run the plugins' migrations one plugin after the other. A plugin whose migration fails is turned off, so its
   * `setup()` doesn't run against tables that aren't what it expects.
   */
  private async migrate(host: PluginHost<ServerPlugin, ServerPluginContext>, plugins: LoadedPlugin<ServerPlugin>[], db: Kysely<any>) {
    for (const plugin of plugins) {
      try {
        const applied = await runPluginMigrations(db, plugin.package, plugin.plugin.migrations!)
        if (applied.length)
          this.logger.info(`Plugin ${PluginHost.label(plugin)}: ran migrations ${applied.join(', ')}`)
      }
      catch (err) {
        host.remove(plugin.package)
        this.logger.error(`Plugin ${PluginHost.label(plugin)} turned off: ${(err as Error).message}`)
      }
    }
  }

  private startServer(host: PluginHost<ServerPlugin, ServerPluginContext>) {
    this.plugins = host
    this.openAuth(host)
    this.openNotifications(host)
    // Told apart per plugin, so GET /api/game/routes can say which plugin a route comes from
    const asPlugin = (loaded: LoadedPlugin<ServerPlugin>, call: () => void) =>
      this.http.routes.registerAs({ source: 'plugin', plugin: loaded.package }, call)

    this.plugins.exposeApis()
    this.plugins.runAround('setup', asPlugin)

    // After setup(), where plugins register their job classes
    if (this.options.queue?.work !== false)
      this.queue.start()

    this.http.start()
    this.startMetrics()

    /**
     * Register any http functionality in your own server
     */
    if (this.onHttpCallback) {
      this.onHttpCallback(this.httpServer)
    }

    this.plugins.runAround('http', asPlugin, this.httpServer)

    // Last, because the client answers every page request the routes above leave
    const servesClient = this.http.serveClient() && !!this.http.server
    if (servesClient) {
      // geckos matches its /.wrtc/v2 routes anywhere in the path, so this also answers a client
      // that connects through a /socket prefix, like the template does
      this.gameSocket.addServer(this.http.server!)
      this.logger.info('Game socket reachable on the HTTP server')
    }

    const socketPort = this.options.socketPort ?? (servesClient ? false : 8081)
    if (socketPort !== false) {
      this.logger.info('Starting @mavon/engine - Socket Server')
      this.gameSocket.listen(socketPort)
    }

    if (this.options.stopOnSignals !== false)
      Server.watchSignals(this as unknown as Server<GameObject>)
  }

  /** The servers that stop on SIGINT and SIGTERM, with one listener for all of them, so many servers add no more */
  private static stopOnSignal = new Set<Server<GameObject>>()
  private static signalListener?: (signal: NodeJS.Signals) => void

  private static watchSignals(server: Server<GameObject>) {
    Server.stopOnSignal.add(server)
    if (Server.signalListener)
      return

    // stop() removes this listener right away, so a second Ctrl+C while stopping gets Node's default: exit now
    const listener = (signal: NodeJS.Signals) => {
      const servers = [...Server.stopOnSignal]
      servers.forEach((s) => {
        s.logger.info(`${signal}: stopping the server`)
        // Free the port first: a dev watcher starts the next server without waiting for this one to exit
        s.http.server?.close()
      })
      const timeout = setTimeout(() => {
        servers.forEach(s => s.logger.warn(`The server did not stop within ${SIGNAL_STOP_TIMEOUT_MS} ms, exiting anyway`))
        process.exit(1)
      }, SIGNAL_STOP_TIMEOUT_MS)
      timeout.unref()

      void Promise.all(servers.map(s => s.stop())).then(() => {
        clearTimeout(timeout)
        process.exit(0)
      })
    }

    Server.signalListener = listener
    STOP_SIGNALS.forEach(signal => process.on(signal, listener))
  }

  private static unwatchSignals(server: Server<GameObject>) {
    Server.stopOnSignal.delete(server)
    const listener = Server.signalListener
    if (Server.stopOnSignal.size > 0 || !listener)
      return

    STOP_SIGNALS.forEach(signal => process.off(signal, listener))
    Server.signalListener = undefined
  }

  /** Whether the active scene's file is watched and reloaded on change */
  get sceneWatched(): boolean {
    return !!this.sceneWatcher
  }

  /**
   * The plugins of the project, for GET /api/game/plugins: everything in mavonengine.json when the server knows
   * its project root, and in any case the plugins it runs, also those passed to it directly.
   */
  pluginInfos(): ServerPluginInfo[] {
    const running = new Set(this.plugins?.plugins.map(loaded => loaded.package))
    let infos: ServerPluginInfo[] = []

    const root = this.projectRoot
    if (root) {
      try {
        infos = pluginInfos(root, { readme: false }).map(({ readme: _readme, ...info }) => ({
          ...info,
          runningOnServer: running.has(info.package),
        }))
      }
      catch (err) {
        this.logger.warn(`Could not read the project's plugins: ${(err as Error).message}`)
      }
    }

    const listed = new Set(infos.map(info => info.package))
    for (const pkg of running) {
      if (!listed.has(pkg)) {
        infos.push({
          package: pkg,
          enabled: true,
          installed: true,
          target: 'server',
          declaredPrefabs: [],
          usedPrefabs: [],
          runningOnServer: true,
        })
      }
    }

    const database = this.databaseProvider
    const auth = this.authProvider
    const notifications = this.notificationsProvider
    return infos.map((info) => {
      if (info.package === database)
        info = { ...info, database: true }
      if (info.package === auth)
        info = { ...info, auth: true }
      if (info.package === notifications)
        info = { ...info, notifications: true }
      return info
    })
  }

  get projectRoot(): string | undefined {
    const plugins = this.options.plugins
    return this.options.root ?? (plugins && !Array.isArray(plugins)
      ? plugins.root
      : undefined)
  }

  /**
   * Load a scene file into the game world. Only the scene objects with a `server` factory are built.
   * Listen to `game.on('sceneLoaded', scene => …)` to act on it, which also runs on every reload.
   *
   * @param scene a scene name, read from `<root>/scenes/<name>.json`, or a path to a scene file
   */
  openScene(scene: string, options: OpenSceneOptions = {}): GameScene {
    const file = this.sceneFile(scene)
    const loaded = this.game.loadScene(readSceneFile(file), sceneNameOf(file))
    this.activeSceneFile = file

    this.sceneWatcher?.close()
    this.sceneWatcher = undefined
    if (options.watch ?? !!this.options.client?.dev)
      this.watchScene(file)

    return loaded
  }

  private sceneFile(scene: string): string {
    if (scene.endsWith('.json') || isAbsolute(scene))
      return resolve(this.projectRoot ?? '.', scene)

    const root = this.projectRoot
    if (!root)
      throw new Error(`Cannot find scene "${scene}": set the server's \`root\` option or pass a path to the scene file`)
    return sceneFilePath(root, scene)
  }

  /**
   * The editor writes scenes to a temporary file and renames it, so the directory is watched rather than the file
   */
  private watchScene(file: string) {
    let timer: ReturnType<typeof setTimeout> | undefined
    const name = basename(file)

    this.sceneWatcher = watch(dirname(file), (_event, changed) => {
      if (changed !== name)
        return

      clearTimeout(timer)
      timer = setTimeout(() => {
        try {
          this.game.loadScene(readSceneFile(file), sceneNameOf(file))
          this.logger.info(`Scene ${name} changed, reloaded it`)
        }
        catch (err) {
          this.logger.error(`Scene ${name} changed but could not be loaded, keeping the current one: ${(err as Error).message}`)
        }
      }, 50)
    })
    this.sceneWatcher.on('error', err => this.logger.warn(`Stopped watching scene ${name}: ${err.message}`))
  }

  /**
   * Stop the metric sampling and logging timers, the scene watcher, the queue and the plugins, then close the database
   * once the running jobs and plugins' `destroy()` finished.
   * The returned promise settles once the database is closed, and never rejects.
   */
  stop(): Promise<void> {
    Server.unwatchSignals(this as unknown as Server<GameObject>)
    if (this.notifications && currentNotifier() === this.notifications.notifier)
      setNotifier(undefined)
    this.notifications = undefined
    this.timers.forEach(timer => clearInterval(timer))
    this.timers = []

    this.sceneWatcher?.close()
    this.sceneWatcher = undefined

    const draining = this.queue.stop()

    // Plugins may still be saving in destroy(), so the database is closed after they finished
    const saving = (this.plugins?.collect('destroy') ?? []).map(({ plugin, result }) =>
      Promise.resolve(result).catch((err: Error) => {
        this.logger.error(`Plugin ${PluginHost.label(plugin)} failed in destroy(): ${err?.stack ?? err}`)
      }))
    this.plugins = undefined

    const database = this.database
    this.database = undefined
    if (!database)
      return Promise.all([draining, ...saving]).then(() => {})

    return Promise.all([draining, ...saving])
      .then(() => database.db.destroy())
      .catch((err: Error) => {
        this.logger.error(`Could not close the database: ${err?.message ?? err}`)
      })
  }

  private startMetrics() {
    const logIntervalMs = this.options.metrics?.logIntervalMs ?? 5000

    this.timers.push(setInterval(() => this.sampleMetrics(), this.metrics.sampleIntervalMs))

    this.timers.push(setInterval(() => this.logStats(logIntervalMs), logIntervalMs))
  }

  /**
   * Periodic CPU / bandwidth summary. Skipped while a dashboard is fetching
   * metrics, since it already shows the same numbers live.
   */
  private logStats(logIntervalMs: number) {
    const watching = this.http.metricsClientActive()

    if (watching !== this.dashboardWatching) {
      this.dashboardWatching = watching
      this.logger.info(watching
        ? 'Metrics dashboard connected, pausing CPU / bandwidth log output'
        : 'Metrics dashboard disconnected, resuming CPU / bandwidth log output')
    }

    if (watching)
      return

    const { sent, received } = this.bandwidthTracker.getTotalSince(logIntervalMs)
    this.logger.debug(`Client - Sent: ${sent} B, Received: ${received} B`)

    this.metrics.cpu.log()
  }
}
