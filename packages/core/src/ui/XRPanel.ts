import type { Object3D } from 'three'
import type { XRHand } from '../XRInput'
import { CanvasTexture, DoubleSide, LinearFilter, Mesh, MeshBasicMaterial, PlaneGeometry, Quaternion, SRGBColorSpace, Vector3 } from 'three'
import EventEmitter from '../Utils/EventEmitter'

export interface XRPanelOptions {
  /** The panel's width in the world, in meters. Default 1 */
  width?: number
  /** The panel's height, in meters. Default 0.6 */
  height?: number
  /** Canvas pixels per meter of panel: how sharp it is. Default 1000 (1 m wide is 1000 px) */
  pixelsPerMeter?: number
  /**
   * Where the panel goes:
   * - `'head'` (the default): in front of the player when opened, and back in front once they've looked well away
   *   from it, gliding there. For menus and messages
   * - `'none'`: where the game puts `mesh`, in the camera rig's space
   */
  follow?: 'head' | 'none'
  /** How far in front of the head the panel floats, in meters. Default 1.5 */
  distance?: number
  /** How far below eye level its centre sits, in meters. Default 0.15 */
  drop?: number
  /** How far (degrees) the view turns from the panel before it follows. Default 35 */
  followAngle?: number
}

/** A controller pointing at a panel: where on its canvas, in pixels from the top left */
export interface XRPanelPointerEvent {
  hand: XRHand
  /** Canvas pixels from the left */
  x: number
  /** Canvas pixels from the top */
  y: number
}

const forward = new Vector3()
const target = new Vector3()
const targetRotation = new Quaternion()
const up = new Vector3(0, 1, 0)

/**
 * A flat panel floating in VR with a canvas on it, for what a headset has to show where the page's HTML can't be
 * seen: a menu, a scoreboard, a message. Draw on `ctx`, then call `redraw()`. Added to the game with
 * `game.xr.addPanel(panel)`, shown while in VR and `open()`.
 *
 * The controllers point at it (XRPointer): `pointermove`, `pointerleave`, `pointerdown`, `pointerup` and `click`
 * (XRPanelPointerEvent, in canvas pixels), the trigger pressing.
 *
 * It sits in the camera rig, so it moves with the player, unlit, out of tone mapping and fog and drawn over the scene.
 */
export default class XRPanel extends EventEmitter {
  readonly canvas = document.createElement('canvas')
  readonly ctx: CanvasRenderingContext2D
  readonly mesh: Mesh<PlaneGeometry, MeshBasicMaterial>
  readonly options: Required<XRPanelOptions>

  private texture: CanvasTexture
  private _open = false
  /** Gliding back in front of the head */
  private following = false
  /** Placed in front of the head since it was opened */
  private placed = false

  constructor(options: XRPanelOptions = {}) {
    super()
    this.options = {
      width: 1,
      height: 0.6,
      pixelsPerMeter: 1000,
      follow: 'head',
      distance: 1.5,
      drop: 0.15,
      followAngle: 35,
      ...options,
    }
    const { width, height, pixelsPerMeter } = this.options
    this.canvas.width = Math.round(width * pixelsPerMeter)
    this.canvas.height = Math.round(height * pixelsPerMeter)
    this.ctx = this.canvas.getContext('2d')!

    this.texture = new CanvasTexture(this.canvas)
    this.texture.colorSpace = SRGBColorSpace
    this.texture.minFilter = LinearFilter
    this.texture.generateMipmaps = false

    this.mesh = new Mesh(
      new PlaneGeometry(width, height),
      new MeshBasicMaterial({
        map: this.texture,
        transparent: true,
        side: DoubleSide,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
        fog: false,
      }),
    )
    this.mesh.name = 'XRPanel'
    this.mesh.renderOrder = 1001
    this.mesh.visible = false
    this.mesh.userData.xrPanel = this
  }

  get isOpen() {
    return this._open
  }

  /** Show the panel while in VR; with `follow: 'head'` in front of the player */
  open() {
    if (!this._open)
      this.placed = false
    this._open = true
  }

  close() {
    this._open = false
  }

  /** Upload what was drawn on `ctx` */
  redraw() {
    this.texture.needsUpdate = true
  }

  /**
   * Shows or hides the mesh, and with `follow: 'head'` keeps it in front of the head. Called by XR every rendered
   * frame. `head` is the camera, a child of the rig the panel is in, so its position and rotation are the rig's space
   */
  update(head: Object3D, presenting: boolean, delta: number) {
    this.mesh.visible = this._open && presenting
    if (!this.mesh.visible || this.options.follow !== 'head')
      return

    this.inFront(head)
    if (!this.placed) {
      this.mesh.position.copy(target)
      this.mesh.quaternion.copy(targetRotation)
      this.placed = true
      this.following = false
      return
    }

    // Follows once the view has turned well away, then glides all the way back in front, so it doesn't swim with
    // every small movement of the head
    const fromHead = this.mesh.position.clone().sub(head.position).setY(0).normalize()
    const angle = fromHead.angleTo(forward) * 180 / Math.PI
    if (angle > this.options.followAngle)
      this.following = true
    if (!this.following)
      return

    const t = 1 - Math.exp(-delta * 6)
    this.mesh.position.lerp(target, t)
    this.mesh.quaternion.slerp(targetRotation, t)
    if (this.mesh.position.distanceTo(target) < 0.01)
      this.following = false
  }

  /** Where in front of the head the panel goes: level, facing the head, `distance` out along where it looks */
  private inFront(head: Object3D) {
    forward.set(0, 0, -1).applyQuaternion(head.quaternion).setY(0)
    if (forward.lengthSq() < 1e-6)
      forward.set(0, 0, -1) // looking straight up or down
    forward.normalize()
    target.copy(head.position).addScaledVector(forward, this.options.distance)
    target.y -= this.options.drop
    // Upright, turned about the vertical so its front (+Z) faces back at the head
    targetRotation.setFromAxisAngle(up, Math.atan2(-forward.x, -forward.z))
  }

  dispose() {
    this._open = false
    this.texture.dispose()
    this.mesh.geometry.dispose()
    this.mesh.material.dispose()
    this.mesh.removeFromParent()
  }
}
