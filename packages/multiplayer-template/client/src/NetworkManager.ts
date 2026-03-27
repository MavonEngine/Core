import { ClientCommand, ServerCommand } from '@template/server/Commands'
import type { SV_CHAT } from '@template/server/Commands/Server'
import BaseNetworkManager from '@mavonengine/core/Networking/Client/NetworkManager'
import useChat from './UI/composables/useChat'
import useNetworkState from './UI/composables/useNetworkState'
import useStore from './stores/Game'

export default class NetworkManager extends BaseNetworkManager {
  private networkState = useNetworkState().networkState
  private chat = useChat()
  private store = useStore().store

  constructor() {
    super({
      /** @ts-expect-error port is null in prod when behind a reverse proxy */
      port: import.meta.env.PROD ? null : 8081,
      url: import.meta.env.PROD ? '/socket' : undefined,
    })
  }

  protected override onConnect() {
    super.onConnect()
    this.networkState.value.connected = true

    this.socket.on(ServerCommand.SV_STATE, (data) => {
      this.trigger(ServerCommand.SV_STATE, data)
    })

    this.socket.on(ServerCommand.SV_CHAT, (data) => {
      const chat = data as unknown as SV_CHAT
      this.chat.addMessage(chat.playerName, chat.message, chat.playerId === '')
      // Forward to any listeners (e.g. GameSyncManager for chat bubbles)
      this.trigger(ServerCommand.SV_CHAT, chat)
    })

    this.socket.on(ServerCommand.SV_TREES, (data) => {
      this.trigger(ServerCommand.SV_TREES, data)
    })

    this.socket.emit(
      ClientCommand.CL_INIT,
      { name: this.store.value.playerName },
      { reliable: true },
    )
  }

  protected override onPong() {
    this.networkState.value.ping = this.ping
  }

  protected override onDisconnect() {
    this.networkState.value.connected = false
  }

  sendChat(message: string) {
    this.socket.emit(
      ClientCommand.CL_CHAT,
      { message, sequenceId: 0 },
      { reliable: true },
    )
  }
}
