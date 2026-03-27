import type { Object3D } from 'three'
import type GameObject from '@mavonengine/core/World/GameObject'
import ObjectLabel from '@mavonengine/core/ui/ObjectLabel'
import { Vector3 } from 'three'

/**
 * A UILabel that shows a player's name and an optional chat bubble.
 * Extends the engine's ObjectLabel so it auto-projects to screen space.
 */
export default class PlayerLabel extends ObjectLabel {
  private _name: string
  private _isLocal: boolean
  private nameDiv?: HTMLDivElement
  private chatDiv?: HTMLDivElement
  private chatTimeout?: ReturnType<typeof setTimeout>

  constructor(entity: Object3D | GameObject, name: string, isLocal = false) {
    // Offset slightly above the box (box is 1 unit tall, centered at entity.position)
    super(entity, new Vector3(0, 1.1, 0))
    this._name = name
    this._isLocal = isLocal
    this.init()

    this.nameDiv = this.domElement.querySelector<HTMLDivElement>('.player-name')!
    this.chatDiv = this.domElement.querySelector<HTMLDivElement>('.player-chat-bubble')!
  }

  protected createElement(): HTMLDivElement {
    const container = document.createElement('div')
    container.className = 'point player-label'

    const chatDiv = document.createElement('div')
    chatDiv.className = 'player-chat-bubble hidden'
    container.appendChild(chatDiv)

    const nameDiv = document.createElement('div')
    nameDiv.className = `player-name${this._isLocal ? ' local' : ''}`
    nameDiv.textContent = this._name
    container.appendChild(nameDiv)

    return container
  }

  setName(name: string) {
    this._name = name
    if (this.nameDiv) {
      this.nameDiv.textContent = name
    }
  }

  showChatBubble(message: string) {
    if (this.chatTimeout) {
      clearTimeout(this.chatTimeout)
    }
    if (this.chatDiv) {
      this.chatDiv.textContent = message
      this.chatDiv.classList.remove('hidden')
      this.chatTimeout = setTimeout(() => {
        this.chatDiv!.classList.add('hidden')
      }, 5000)
    }
  }

  destroy(): void {
    if (this.chatTimeout) {
      clearTimeout(this.chatTimeout)
    }
    super.destroy()
  }
}
