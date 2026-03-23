import type { Object3D } from 'three'
import type GameObject from '../World/GameObject'
import type GameObjectInterface from '../World/GameObjectInterface'
import { Vector3 } from 'three'
import Game from '../Game'

export default abstract class ObjectLabel implements GameObjectInterface {
  protected entity: Object3D | GameObject
  public domElement!: HTMLDivElement
  public offset: Vector3

  constructor(entity: Object3D | GameObject, offset: Vector3 = new Vector3(0)) {
    this.entity = entity
    this.offset = offset
  }

  protected init() {
    this.domElement = this.createElement()
  }

  protected abstract createElement(): HTMLDivElement

  update(_delta: number): void {
    const worldPosition
      = 'getWorldPosition' in this.entity
        ? this.entity.getWorldPosition(new Vector3())
        : this.entity.position.clone()

    const screenPosition = worldPosition.clone().add(this.offset)
    screenPosition.project(Game.instance().camera.instance)

    const screenX = screenPosition.x
    const screenY = screenPosition.y

    const isVisible
      = screenX >= -1 && screenX <= 1
        && screenY >= -1 && screenY <= 1
        && screenPosition.z >= 0 && screenPosition.z <= 1

    if (isVisible) {
      if (!document.body.contains(this.domElement)) {
        document.body.appendChild(this.domElement)
      }

      const rect = Game.instance().canvas.getBoundingClientRect()
      const canvasOffsetX = rect.left + rect.width / 2 - window.innerWidth / 2
      const canvasOffsetY = rect.top + rect.height / 2 - window.innerHeight / 2
      const translateX = screenX * rect.width / 2 + canvasOffsetX
      const translateY = -screenY * rect.height / 2 + canvasOffsetY

      this.domElement.style.transform
        = `translateX(${translateX}px) translateY(${translateY}px) translate(-50%, -50%)`

      const cameraPos = Game.instance().camera.instance.position
      const distance = worldPosition.distanceTo(cameraPos)

      const maxDistance = 40
      const minDistance = 2

      const clampedDistance = Math.min(Math.max(distance, minDistance), maxDistance)
      const t = 1 - (clampedDistance - minDistance) / (maxDistance - minDistance)

      const scale = 0.5 + t * 0.5
      const opacity = t

      this.domElement.style.opacity = opacity.toFixed(2)
      this.domElement.style.transform += ` scale(${scale.toFixed(2)})`
    }
    else {
      if (document.body.contains(this.domElement)) {
        this.domElement.remove()
      }
    }
  }

  destroy(): void {
    this.domElement.remove()
  }
}
