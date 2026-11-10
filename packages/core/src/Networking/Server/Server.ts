import type RAPIER from '@dimforge/rapier3d-compat'
import type { Data, GeckosServer, ServerChannel } from '@geckos.io/server'
import type { Express } from 'express'
import type { FSWatcher } from 'node:fs'
import type winston from 'winston'
import type { LoadedPlugin, ServerPlugin, ServerPluginContext, ServerPluginInfo } from '../../Plugins/types'
import type GameScene from '../../Scene/GameScene'
import type GameObject from '../../World/GameObject'
import type { NetDebugSource, SyncSnapshot, SyncStateSummary } from '../Debug/sync'
import type NetworkedActor from '../NetworkedActor'
import type { CommandPacket, IncomingClientCommandPacket, StatePacket } from './Commands'
import type { ClientOptions } from './Http/ClientMiddleware'
import type { MetricsEndpointOptions } from './Http/HttpServer'
import type { LatencySimulatorOptions } from './LatencySimulator'
import type { ServerMetricsOptions, ServerMetricsSource } from './Stats/ServerMetrics'
import type { WorldInspectorSource } from './Stats/WorldInspector'
import { Buffer } from 'node:buffer'
import { watch } from 'node:fs'
import { basename, dirname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import geckos from '@geckos.io/server'
import BaseGame from '../../BaseGame'
import { loadServerPlugins } from '../../Plugins/loadServerPlugins'
import PluginHost from '../../Plugins/PluginHost'
import { pluginInfos } from '../../Plugins/ProjectConfig'
import { readSceneFile, sceneFilePath, sceneNameOf } from '../../Scene/loadSceneFile'
import { registerSceneObject, sceneObjectKey } from '../../Scene/SceneObjectRegistry'
import NetRecorder from '../Debug/NetRecorder'
import { rememberJson, tapMessages } from '../Debug/tap'
import Player from '../Entities/Player'
import NetworkedGameObject from '../NetworkedGameObject'
import { ClientCommand, ServerCommand } from './Commands'
import HttpServer, { ADMIN_TOKEN_ENV } from './Http/HttpServer'
import LatencySimulator from './LatencySimulator'
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

/** How many entity ids a sync_enter / sync_leave event lists before it only counts them */
const MAX_SYNC_EVENT_IDS = 20

const vec = ({ x, y, z }: { x: number, y: number, z: number }) => ({ x, y, z })

export default abstract class Server<TClient extends GameObject> implements ServerMetricsSource, WorldInspectorSource, NetDebugSource {
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
  readonly net = new NetRecorder({ enabled: devEndpointsEnabled() })

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

    this.gameSocket = geckos()
    this.logger = logger
    this.options = options ?? {}

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
    })

    this.gameSocket.onConnection((channel) => {
      this.logger.info(`Connected: ${channel.id}`)

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
        this.net.event('dropped', { peer, info: { reason: (drop as { reason?: string }).reason, message: drop.event } })
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
        this.sendState(con.channel, [...this.game.world.entities.items.values()].filter(entity => this.isSynced(entity)), null)
        return
      }

      const player = this.game.world.entities.items.get(id!) as Player
      if (!player)
        return

      const entitiesToSend: GameObject[] = [] // Renamed for clarity

      // Create a temporary set of entities that should be tracked for this player in this tick
      const currentTickTrackedEntities = new Set<string>()
      // Copied, because entities out of range are deleted from the player's set below
      const previouslyTracked = this.net.enabled ? new Set(player.trackedEntities) : undefined

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

    if (entered.length)
      this.net.event('sync_enter', { peer, tick: this.tickCount, info: { count: entered.length, entities: entered.slice(0, MAX_SYNC_EVENT_IDS) } })
    if (left.length)
      this.net.event('sync_leave', { peer, tick: this.tickCount, info: { count: left.length, entities: left.slice(0, MAX_SYNC_EVENT_IDS) } })
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
      this.lastStates.set(channel.id!, { tick: state.tick, bytes: Buffer.byteLength(json), entities: entities.length })
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

    const entities = [...world.entities.items.values()].filter(entity => this.isSynced(entity))

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
   * Start the HTTP server and the game socket. With `options.plugins.root` the plugins are imported first,
   * so wait for the returned promise before relying on them; otherwise everything starts synchronously.
   */
  start(): Promise<void> {
    const plugins = this.options.plugins
    if (plugins && !Array.isArray(plugins)) {
      return loadServerPlugins(plugins.root).then(({ plugins: loaded, warnings }) => {
        warnings.forEach(warning => this.logger.warn(`Plugin skipped: ${warning}`))
        this.startServer(loaded)
      })
    }

    this.startServer((plugins ?? []).map(toLoadedPlugin))
    return Promise.resolve()
  }

  private startServer(plugins: LoadedPlugin<ServerPlugin>[]) {
    this.plugins = new PluginHost<ServerPlugin, ServerPluginContext>(plugins, loaded => ({
      package: loaded.package,
      options: loaded.options,
      game: this.game,
      logger: this.logger,
      server: this as unknown as Server<GameObject>,
      projectRoot: this.projectRoot,
      requireAdmin: this.http.requireAdmin,
      adminToken: this.http.adminToken,
      registerSceneObject: (definition) => {
        registerSceneObject({ ...definition, plugin: loaded.package })
        return sceneObjectKey({ ...definition, plugin: loaded.package })
      },
    }), this.logger, 'server')
    // Told apart per plugin, so GET /api/game/routes can say which plugin a route comes from
    const asPlugin = (loaded: LoadedPlugin<ServerPlugin>, call: () => void) =>
      this.http.routes.registerAs({ source: 'plugin', plugin: loaded.package }, call)

    this.plugins.runAround('setup', asPlugin)

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
        infos = pluginInfos(root, { readme: false }).map(({ readme: _readme, ...info }) => ({ ...info, runningOnServer: running.has(info.package) }))
      }
      catch (err) {
        this.logger.warn(`Could not read the project's plugins: ${(err as Error).message}`)
      }
    }

    const listed = new Set(infos.map(info => info.package))
    for (const pkg of running) {
      if (!listed.has(pkg))
        infos.push({ package: pkg, enabled: true, installed: true, target: 'server', declaredPrefabs: [], usedPrefabs: [], runningOnServer: true })
    }

    return infos
  }

  get projectRoot(): string | undefined {
    const plugins = this.options.plugins
    return this.options.root ?? (plugins && !Array.isArray(plugins) ? plugins.root : undefined)
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
   * Stop the metric sampling and logging timers, the scene watcher and the plugins
   */
  stop() {
    this.timers.forEach(timer => clearInterval(timer))
    this.timers = []

    this.sceneWatcher?.close()
    this.sceneWatcher = undefined

    this.plugins?.run('destroy')
    this.plugins = undefined
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
