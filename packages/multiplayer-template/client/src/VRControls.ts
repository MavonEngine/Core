import type Character from './Entities/Player'
import Game from '@mavonengine/core/Game'
import XRLocomotion from '@mavonengine/core/XRLocomotion'
import { Vector3 } from 'three'

const UP = new Vector3(0, 1, 0)
/** Where the view sits from the character, before turning: behind and above it */
const CHASE_OFFSET = new Vector3(0, 3, 7)
/** How far the camera aims above the character's feet */
const AIM_HEIGHT = 1
/** How quickly the view catches up with the character. Higher is tighter */
const FOLLOW_RATE = 8
const SNAP_ANGLE = Math.PI / 6
const SNAP_THRESHOLD = 0.7
const SNAP_RESET = 0.3
/** How far the left stick has to be pushed to walk */
const WALK_THRESHOLD = 0.3

/**
 * Third person controls in VR: the left stick walks the character the way it's pushed, relative to where the
 * player looks, and the right stick snap turns the view around the character. The view follows the character
 * every rendered frame, smoothing out the tick rate and network updates, and only turns on a snap turn.
 */
export default class VRControls {
  private readonly locomotion: XRLocomotion
  private readonly aim = new Vector3()
  private readonly view = new Vector3()
  private readonly direction = new Vector3()
  private chaseYaw = 0
  private snapArmed = true

  private readonly onFrame = (delta: number) => this.frame(delta)
  private readonly onSessionStart = () => this.reset()

  constructor(private readonly player: Character) {
    const game = Game.instance()
    // Not enabled: it only works out the stick's direction here, the character moves through the server
    this.locomotion = new XRLocomotion(game.camera, game.input.xr!)
    game.on('beforeRender', this.onFrame)
    game.on('xrSessionStart', this.onSessionStart)
    this.reset()
  }

  /** Whether a headset is playing */
  get active(): boolean {
    return Game.instance().xr?.presenting ?? false
  }

  /**
   * The movement for CL_MOVE from the left stick: walk forward, facing the way the stick points in the world.
   * The server walks the character along its yaw.
   */
  move(currentYaw: number): { keys: string[], yaw: number } {
    const stick = Game.instance().input.xr!.left.stick
    if (stick.length() < WALK_THRESHOLD)
      return { keys: [], yaw: currentYaw }

    this.locomotion.getMoveDirection(stick, this.direction)
    // A yaw of 0 walks along -Z
    return {
      keys: ['KeyW'],
      yaw: Math.atan2(-this.direction.x, -this.direction.z),
    }
  }

  private reset() {
    this.chaseYaw = this.player.rotation.y
    this.aim.copy(this.player.position).y += AIM_HEIGHT
  }

  private frame(delta: number) {
    if (!this.active)
      return

    const x = Game.instance().input.xr!.right.stick.x
    if (Math.abs(x) < SNAP_RESET) {
      this.snapArmed = true
    }
    else if (this.snapArmed && Math.abs(x) > SNAP_THRESHOLD) {
      this.chaseYaw -= Math.sign(x) * SNAP_ANGLE
      this.snapArmed = false
    }

    this.direction.copy(this.player.position).y += AIM_HEIGHT
    this.aim.lerp(this.direction, 1 - Math.exp(-FOLLOW_RATE * delta))

    this.view.copy(CHASE_OFFSET).applyAxisAngle(UP, this.chaseYaw).add(this.aim)
    // Turned only by chaseYaw, which changes on snap turns alone
    Game.instance().camera.place(this.view, this.aim)
  }

  destroy() {
    Game.instance().off('beforeRender', this.onFrame)
    Game.instance().off('xrSessionStart', this.onSessionStart)
  }
}
