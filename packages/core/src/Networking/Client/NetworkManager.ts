import type { ClientChannel } from '@geckos.io/client'
import type { ClientOptions } from '@geckos.io/common/lib/types'

import { geckos } from '@geckos.io/client'
import Game from '../../BaseGame'
import EventEmitter from '../../Utils/EventEmitter'

let instance: NetworkManager | undefined

export default class NetworkManager extends EventEmitter {
  protected _socket: ClientChannel
  ping = 1000
  pingNow = 0
  private _connected = false

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

  protected onPong() {}

  protected onDisconnect() {}

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
