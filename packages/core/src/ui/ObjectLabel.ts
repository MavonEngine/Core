import type { Object3D } from 'three'
import type GameObject from '../World/GameObject'
import type GameObjectInterface from '../World/GameObjectInterface'
import type { TextLabelOptions } from './TextLabel'
import { Vector3 } from 'three'
import Game from '../Game'
import TextLabel from './TextLabel'

/**
 * An HTML label kept over a 3D object on screen. Call `update()` every tick.
 *
 * A VR headset doesn't show the page, so while one plays the label is drawn in the scene instead (TextLabel), with
 * the text `xrText()` gives: by default the element's text. Return `undefined` from it to show nothing in VR.
 */
export default abstract class ObjectLabel implements GameObjectInterface {
  protected entity: Object3D | GameObject
  public domElement!: HTMLDivElement
  public offset: Vector3
  /** The label in the scene while a headset plays */
  protected xrLabel?: TextLabel

  constructor(entity: Object3D | GameObject, offset: Vector3 = new Vector3(0)) {
    this.entity = entity
    this.offset = offset
  }

  protected init() {
    this.domElement = this.createElement()
  }

  protected abstract createElement(): HTMLDivElement

  /**
   * What the label reads in VR, lines split on `\n`: by default all the element's text, run together, hidden parts
   * too. Override it to give what shows, line by line
   */
  protected xrText(): string | undefined {
    return this.domElement.textContent?.trim() || undefined
  }

  /** How the label in VR looks: overridden to style it */
  protected xrLabelOptions(): TextLabelOptions {
    return { angularSize: 1.6, depthTest: true }
  }

  update(_delta: number): void {
    const worldPosition
      = 'getWorldPosition' in this.entity
        ? this.entity.getWorldPosition(new Vector3())
        : this.entity.position.clone()

    if (this.updateXR(worldPosition))
      return

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

      const cameraPos = Game.instance().camera.worldPosition
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

  /** In VR, the label in the scene instead of the element: whether it took over */
  private updateXR(worldPosition: Vector3) {
    const game = Game.instance()
    const text = game.renderer.xrPresenting
      ? this.xrText()
      : undefined
    if (text === undefined) {
      this.xrLabel?.removeFromParent()
      return false
    }

    this.domElement.remove()
    if (!this.xrLabel)
      this.xrLabel = new TextLabel(text, this.xrLabelOptions())
    if (!this.xrLabel.parent)
      game.scene.add(this.xrLabel)
    this.xrLabel.setText(text)
    this.xrLabel.position.copy(worldPosition).add(this.offset)
    this.xrLabel.update(game.camera.instance)
    return true
  }

  destroy(): void {
    this.domElement.remove()
    this.xrLabel?.dispose()
    this.xrLabel = undefined
  }
}
