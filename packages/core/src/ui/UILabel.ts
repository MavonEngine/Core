import type { Object3D } from 'three'
import type GameObject from '../World/GameObject'
import ObjectLabel from './ObjectLabel'

export default class UILabel extends ObjectLabel {
  private text: string
  private label?: string

  constructor(entity: Object3D | GameObject, text: string, label?: string) {
    super(entity)
    this.text = text
    this.label = label

    this.init()
  }

  protected createElement(): HTMLDivElement {
    const domElement = document.createElement('div')
    domElement.classList.add('point')

    if (this.label) {
      const labelDiv = document.createElement('div')
      labelDiv.classList.add('label')
      labelDiv.textContent = this.label
      domElement.appendChild(labelDiv)
    }

    const textDiv = document.createElement('div')
    textDiv.classList.add('text')
    textDiv.textContent = this.text
    domElement.appendChild(textDiv)

    return domElement
  }
}
