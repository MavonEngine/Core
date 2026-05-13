import type { ClientChannel } from '@geckos.io/client'
import type { ClientOptions } from '@geckos.io/common/lib/types'

import type { CommandPacket } from '../Server/Commands'
import { geckos } from '@geckos.io/client'
import Game from '../../BaseGame'
import EventEmitter from '../../Utils/EventEmitter'

let instance: NetworkManager | undefined

export default class NetworkManager extends EventEmitter {
  protected _socket: ClientChannel
  ping = 1000
  pingNow = 0
  private _connected = false

  private currentSequenceId = 0

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

    this._socket = geckos(options)

    this._socket.onConnect((error) => {
      if (error) {
        Game.instance().logger?.error(`Socket error: ${error.message}`)
        return
      }

      Game.instance().logger?.info(`Socket connection established: ${this._socket.id}`)
      this._connected = true
      this.onConnect()
    })

    this._socket.onDisconnect(() => {
      Game.instance().logger?.info('Socket disconnected')

      this._connected = false
      this.onDisconnect()
    })

    Game.instance().on('editorBoot', () => {
      this._socket.close()
    })
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
