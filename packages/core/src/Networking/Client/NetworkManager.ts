import type { ClientChannel } from '@geckos.io/client'
import type { ClientOptions } from '@geckos.io/common/lib/types'

import type { Vec3 } from '../../Dev/inspect'
import type PluginHost from '../../Plugins/PluginHost'
import type { ClientPlugin, ClientPluginContext } from '../../Plugins/types'
import type { Identity } from '../identity'
import type { CommandPacket, StatePacket } from '../Server/Commands'
import { geckos } from '@geckos.io/client'
import Game from '../../BaseGame'
import EventEmitter from '../../Utils/EventEmitter'
import NetRecorder, { netDebugDefault } from '../Debug/NetRecorder'
import { tapMessages } from '../Debug/tap'
import { identityOf } from '../identity'
import { ClientCommand, ServerCommand } from '../Server/Commands'

/** An entity as the server last sent it, before the client smoothed or predicted anything */
export interface ServerEntityView {
  id: string
  type: string | null
  position: Vec3
  rotation: Vec3
  scale: Vec3
  /** Server tick of the state it was last in */
  tick: number
  /** `performance.now()` when that state arrived */
  receivedAt: number
}

/** The last sv_state this client received */
export interface ServerView {
  /** Null until the first state arrived */
  tick: number | null
  /** Epoch ms on the server when the state was taken */
  serverTime: number | null
  /** Last input of this client the server had processed, null for the editor */
  ack: number | null
  /** `performance.now()` when it arrived */
  receivedAt: number | null
  /** States that never arrived, counted from gaps in the tick numbers */
  missedStates: number
  /** Raw server state per entity id. Only filled while `net` records, for the dev tools */
  entities: Map<string, ServerEntityView>
}

function vec(value: unknown): Vec3 {
  const { x = 0, y = 0, z = 0 } = (value ?? {}) as Partial<Vec3>
  return { x, y, z }
}

let instance: NetworkManager | undefined

/** Why connecting failed. `status` is the HTTP status the server turned the client away with, e.g. 401 from its auth plugin */
export interface ConnectError {
  message: string
  status?: number
  statusText?: string
}

function clientPlugins(): PluginHost<ClientPlugin, ClientPluginContext> | undefined {
  return (Game.instance() as { plugins?: PluginHost<ClientPlugin, ClientPluginContext> }).plugins
}

/** The `Authorization` header the client plugins give, from the first that returns one */
function pluginAuthorization(): string | undefined {
  return clientPlugins()?.collect('authorization').find(({ result }) => typeof result === 'string')?.result
}

export default class NetworkManager extends EventEmitter {
  protected _socket: ClientChannel
  ping = 1000
  pingNow = 0
  private _connected = false
  private _connectError: ConnectError | null = null
  private _editorMode = false

  private currentSequenceId = 0

  /**
   * The last packets and network events of this client, for the dev tools. Off unless the dev bridge
   * or the editor runs; turn it on with `net.enabled = true`.
   */
  readonly net = new NetRecorder({
    enabled: netDebugDefault(),
  })

  /** What the server last sent, untouched by interpolation or prediction */
  readonly serverView: ServerView = {
    tick: null,
    serverTime: null,
    ack: null,
    receivedAt: null,
    missedStates: 0,
    entities: new Map(),
  }

  /**
   * This command queue is used for replaying packets locally.
   * When ServerCommand.SV_STATE comes in we drop anything thats below
   * the lastProcessedSequenceId
   */
  private localCommandQueue: CommandPacket<any>[] = []

  constructor(options: ClientOptions) {
    super()
    // eslint-disable-next-line ts/no-this-alias
    instance = this
    // Lets dev tools (the editor, the dev bridge) find the connection from the game
    ;(Game.instance() as { network?: NetworkManager }).network = this

    // Sent as the Authorization header of the connection request, for the server's auth plugin
    this._socket = geckos({ ...options, authorization: options.authorization ?? pluginAuthorization() })

    // Only hooked into the socket once something records
    this.net.onEnabled(() => {
      const internals = this._socket as unknown as { connectionsManager?: unknown, bridge?: unknown }
      tapMessages(internals.connectionsManager, 'emit', 'out', this.net)
      tapMessages(internals.bridge, 'emit', 'in', this.net)
    })

    this._socket.on(ServerCommand.SV_STATE, data => this.trackServerState(data as unknown as StatePacket))
    this._socket.on(ServerCommand.SV_REMOVE_ENTITY, data => this.serverView.entities.delete((data as unknown as { id: string }).id))

    this._socket.onConnect((error) => {
      if (error) {
        const failed = error as ConnectError
        this._connectError = failed
        Game.instance().logger?.error(`Socket error: ${failed.message}`)
        this.net.event('connect_error', {
          info: { status: failed.status ?? null, message: failed.message },
        })
        clientPlugins()?.run('onConnectError', { message: failed.message, status: failed.status })
        this.onConnectError(failed)
        this.trigger('connectError', failed)
        return
      }

      Game.instance().logger?.info(`Socket connection established: ${this._socket.id}`)
      this._connected = true
      this._connectError = null
      this.net.event('connect', {
        info: { id: this._socket.id },
      })
      if (this._editorMode)
        this.announceEditor()
      this.onConnect()
    })

    this._socket.onDisconnect(() => {
      Game.instance().logger?.info('Socket disconnected')

      this._connected = false
      this.net.event('disconnect')
      this.onDisconnect()
    })

    /**
     * The connection stays open when the editor boots, so what the server sends keeps showing in the editor.
     * The server is told so it stops treating this client as a player.
     */
    // Created after the editor booted, e.g. the editor connects to watch the game without having joined
    this._editorMode = !!(Game.instance() as { editor?: unknown }).editor

    if (this._editorMode)
      this.net.enabled = true

    Game.instance().on('editorBoot', () => {
      this._editorMode = true
      this.net.enabled = true
      if (this._connected)
        this.announceEditor()
    })
  }

  /**
   * Keep what the server said about its tick and, for the dev tools, about each entity
   */
  private trackServerState(state: StatePacket) {
    const view = this.serverView
    const now = performance.now()

    if (typeof state?.tick === 'number') {
      if (view.tick !== null && state.tick > view.tick + 1) {
        const missed = state.tick - view.tick - 1
        view.missedStates += missed
        this.net.event('state_gap', {
          tick: state.tick,
          info: { missed, after: view.tick },
        })
      }
      else if (view.tick !== null && state.tick <= view.tick) {
        // Arrived after a newer one: the data channel is unordered
        this.net.event('state_out_of_order', {
          tick: state.tick,
          info: { newest: view.tick },
        })
        return
      }

      view.tick = state.tick
      view.serverTime = state.serverTime ?? null
      view.ack = state.ack ?? null
    }
    view.receivedAt = now

    if (!this.net.enabled || !Array.isArray(state?.entities))
      return

    for (const entity of state.entities as { id?: string, $typeName?: string, position?: unknown, rotation?: unknown, scale?: unknown }[]) {
      if (typeof entity?.id !== 'string')
        continue
      view.entities.set(entity.id, {
        id: entity.id,
        type: entity.$typeName ?? null,
        position: vec(entity.position),
        rotation: vec(entity.rotation),
        scale: entity.scale
          ? vec(entity.scale)
          : { x: 1, y: 1, z: 1 },
        tick: view.tick ?? 0,
        receivedAt: now,
      })
    }
  }

  private announceEditor() {
    this._socket.emit(ClientCommand.CL_EDITOR, { type: ClientCommand.CL_EDITOR }, { reliable: true })
  }

  /**
   * Why the last attempt to connect failed, e.g. `status` 401 when the server's auth plugin turned this client away.
   * Null before and once connected. Kept, unlike the `connectError` event, for whoever looks after it happened
   */
  get connectError(): ConnectError | null {
    return this._connectError
  }

  /**
   * Who the server's auth plugin let this client in as, once connected. Undefined before, and when the server has no
   * auth plugin or let it in without an identity.
   */
  get identity(): Identity | undefined {
    return identityOf(this._socket as { userData?: unknown })
  }

  /** Whether this client runs the editor and so is no player on the server */
  get editorMode() {
    return this._editorMode
  }

  protected onConnect() {
    setInterval(() => this.pingCheck(), 1000)

    this._socket.on('pong', () => {
      this.ping = Math.ceil(performance.now() - this.pingNow)
      this.onPong()
    })
  }

  destroy() {
    if (this._connected)
      this._socket.close()

    this._connected = false
    instance = undefined
    const game = Game.instance() as { network?: NetworkManager }
    if (game.network === this)
      game.network = undefined
  }

  /**
   * All commands need to go through here to get the
   * sequenceId assigned and add it to the queue for local replay
   */
  public sendCommand(commandPacket: CommandPacket<any>) {
    commandPacket.sequenceId = this.currentSequenceId++

    this.localCommandQueue.push(commandPacket)
    this.socket.emit('command', commandPacket)
  }

  public dropCommandsAtSequenceId(sequenceId: number) {
    this.localCommandQueue = this.localCommandQueue.filter(packet => packet.sequenceId! > sequenceId)
  }

  protected onPong() { }

  protected onDisconnect() { }

  /**
   * Connecting failed, e.g. the server's auth plugin turned the client away (`error.status` 401, 403, …).
   * Also triggered as the `connectError` event. The client does not try again: make a new NetworkManager for that.
   */
  protected onConnectError(_error: ConnectError) { }

  protected pingCheck() {
    this.pingNow = performance.now()
    this._socket.emit('ping')
  }

  get socket() {
    return this._socket
  }

  get connected() {
    return this._connected
  }

  static getInstance() {
    return instance!
  }
}
