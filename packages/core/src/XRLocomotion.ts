import type { Vector2 } from 'three'
import type Camera from './Camera'
import type { XRHand } from './XRInput'
import type XRInput from './XRInput'
import { Vector3 } from 'three'

export interface XRLocomotionOptions {
  /** Walking speed at full stick, in meters per second. Default 2 */
  speed?: number
  /** The stick that moves. Default 'left' */
  moveHand?: XRHand
  /** The stick that turns. Default 'right' */
  turnHand?: XRHand
  /**
   * 'snap' (the default) turns in steps on a stick flick, which most players find comfortable.
   * 'smooth' turns continuously, which makes many players queasy. false leaves turning to the player's body.
   */
  turn?: 'snap' | 'smooth' | false
  /** How far a snap turn turns, in radians. Default 30 degrees */
  snapAngle?: number
  /** How fast a smooth turn turns at full stick, in radians per second. Default 90 degrees */
  turnSpeed?: number
  /** Move where the head looks, up and down too, instead of staying level. Default false */
  fly?: boolean
}

/** How far the stick has to be flicked to snap turn, and let back for the next one */
const SNAP_THRESHOLD = 0.7
const SNAP_RESET = 0.3

const UP = new Vector3(0, 1, 0)
const forward = new Vector3()
const right = new Vector3()
const move = new Vector3()

/**
 * Moves the player through the world with the controllers' thumbsticks, by moving the camera rig, in VR only.
 * Created by `game.xr.enableLocomotion()` and run every rendered frame.
 *
 * It moves freely and goes through walls: games with physics or their own character move that instead, e.g.
 * with `getMoveDirection()`, and place the view with `camera.place()`.
 */
export default class XRLocomotion {
  enabled = true

  speed: number
  moveHand: XRHand
  turnHand: XRHand
  turn: 'snap' | 'smooth' | false
  snapAngle: number
  turnSpeed: number
  fly: boolean

  private snapArmed = true

  constructor(private readonly camera: Camera, private readonly input: XRInput, options: XRLocomotionOptions = {}) {
    this.speed = options.speed ?? 2
    this.moveHand = options.moveHand ?? 'left'
    this.turnHand = options.turnHand ?? 'right'
    this.turn = options.turn ?? 'snap'
    this.snapAngle = options.snapAngle ?? Math.PI / 6
    this.turnSpeed = options.turnSpeed ?? Math.PI / 2
    this.fly = options.fly ?? false
  }

  /**
   * Where a stick points in the world, relative to where the player looks: pushing forward is the way the head
   * faces. Level with the ground unless `fly`, and as long as the stick is pushed (0 - 1).
   */
  getMoveDirection(stick: Vector2, target = new Vector3()): Vector3 {
    this.camera.instance.getWorldDirection(forward)
    if (!this.fly)
      forward.y = 0
    if (forward.lengthSq() < 1e-8)
      return target.set(0, 0, 0)
    forward.normalize()
    right.crossVectors(forward, UP).normalize()

    return target.copy(forward).multiplyScalar(stick.y).addScaledVector(right, stick.x)
  }

  /** Apply one frame of the sticks */
  update(delta: number) {
    if (!this.enabled)
      return

    const moveStick = this.input[this.moveHand].stick
    if (moveStick.lengthSq() > 0) {
      this.getMoveDirection(moveStick, move)
      this.camera.rig.position.addScaledVector(move, this.speed * delta)
    }

    this.updateTurn(delta, this.input[this.turnHand].stick.x)
  }

  private updateTurn(delta: number, x: number) {
    if (this.turn === 'smooth') {
      if (x !== 0)
        this.camera.turn(-x * this.turnSpeed * delta)
      return
    }

    if (this.turn !== 'snap')
      return

    if (Math.abs(x) < SNAP_RESET) {
      this.snapArmed = true
    }
    else if (this.snapArmed && Math.abs(x) > SNAP_THRESHOLD) {
      // Pushing right turns right, which is clockwise seen from above: a negative angle around +Y
      this.camera.turn(-Math.sign(x) * this.snapAngle)
      this.snapArmed = false
    }
  }
}
