import type Character from './Entities/Player'
import Game from '@mavonengine/core/Game'
import XRLocomotion from '@mavonengine/core/XRLocomotion'
import { Vector2, Vector3 } from 'three'

const UP = new Vector3(0, 1, 0)
/** Where the view sits from the character, before turning: behind and above it */
const CHASE_OFFSET = new Vector3(0, 3, 7)
/** How far the camera aims above the character's position, the center of its collider */
const AIM_HEIGHT = 1
/** How far the model's feet are below the character's position */
const FOOT_OFFSET = 0.8
/** How quickly the view catches up with the character before its model is loaded. Higher is tighter */
const FOLLOW_RATE = 8
const SNAP_ANGLE = Math.PI / 6
const SNAP_THRESHOLD = 0.7
const SNAP_RESET = 0.3
/** How far the left stick has to be pushed to walk */
const WALK_THRESHOLD = 0.3
/** How far the view turns per pixel the mouse is dragged sideways, in radians */
const MOUSE_TURN = 0.005

/**
 * Third person controls in VR, with the controllers or the keyboard and mouse:
 *
 * - the left stick, or WASD, walks the character the way it's pushed, relative to where the player looks
 * - a right stick flick, or Q / E, snap turns the view around the character
 * - dragging the mouse sideways turns the view around the character
 *
 * The view follows the character every rendered frame, smoothing out the tick rate and network updates, and only
 * turns when the player turns it. The headset alone decides where the player looks up and down.
 */
export default class VRControls {
  private readonly locomotion: XRLocomotion
  private readonly aim = new Vector3()
  private readonly view = new Vector3()
  private readonly direction = new Vector3()
  private readonly keyStick = new Vector2()
  private chaseYaw = 0
  private snapArmed = true

  private readonly onFrame = (delta: number) => this.frame(delta)
  private readonly onSessionStart = () => this.reset()
  private readonly onKeydown = (event: KeyboardEvent) => this.keydown(event)
  private readonly onMousemove = (event: MouseEvent) => this.mousemove(event)

  constructor(private readonly player: Character) {
    const game = Game.instance()
    // Not enabled: it only works out the stick's direction here, the character moves through the server
    this.locomotion = new XRLocomotion(game.camera, game.input.xr!)
    game.on('beforeRender', this.onFrame)
    game.on('xrSessionStart', this.onSessionStart)
    game.input.on('keydown', this.onKeydown)
    window.addEventListener('mousemove', this.onMousemove)
    this.reset()
  }

  /** Whether a headset is playing */
  get active(): boolean {
    return Game.instance().xr?.presenting ?? false
  }

  /**
   * The movement for CL_MOVE from the left stick, or WASD while it isn't pushed: walk forward, facing the way it
   * points in the world. The server walks the character along its yaw.
   */
  move(currentYaw: number): { keys: string[], yaw: number } {
    let stick = Game.instance().input.xr!.left.stick
    if (stick.length() < WALK_THRESHOLD) {
      stick = this.keyboardStick()
      if (stick.lengthSq() === 0)
        return { keys: [], yaw: currentYaw }
    }

    this.locomotion.getMoveDirection(stick, this.direction)
    // A yaw of 0 walks along -Z
    return {
      keys: ['KeyW'],
      yaw: Math.atan2(-this.direction.x, -this.direction.z),
    }
  }

  /** WASD as a stick: Y forward, X right */
  private keyboardStick(): Vector2 {
    const keys = Game.instance().input.keysPressed
    return this.keyStick.set(
      Number(keys.has('KeyD')) - Number(keys.has('KeyA')),
      Number(keys.has('KeyW')) - Number(keys.has('KeyS')),
    )
  }

  private reset() {
    this.chaseYaw = this.player.rotation.y
    this.aim.copy(this.player.position).y += AIM_HEIGHT
  }

  /** Turn the view around the character. Positive turns left */
  private turn(angle: number) {
    this.chaseYaw += angle
  }

  private keydown(event: KeyboardEvent) {
    // Not while typing in the chat, and once per press rather than on the key's auto repeat
    if (!this.active || event.repeat || document.activeElement?.tagName === 'INPUT')
      return

    if (event.code === 'KeyQ')
      this.turn(SNAP_ANGLE)
    else if (event.code === 'KeyE')
      this.turn(-SNAP_ANGLE)
  }

  private mousemove(event: MouseEvent) {
    // Dragging with the left button held. Only sideways: tilting the view from the mouse is the headset's job
    if (this.active && (event.buttons & 1))
      this.turn(-event.movementX * MOUSE_TURN)
  }

  private frame(delta: number) {
    if (!this.active)
      return

    const x = Game.instance().input.xr!.right.stick.x
    if (Math.abs(x) < SNAP_RESET) {
      this.snapArmed = true
    }
    else if (this.snapArmed && Math.abs(x) > SNAP_THRESHOLD) {
      this.turn(-Math.sign(x) * SNAP_ANGLE)
      this.snapArmed = false
    }

    // Aim at the model where it's drawn, which already moves smoothly every frame: the character then holds still in
    // the view while the world moves past. Smoothed here only until the model is loaded
    const rendered = this.player.graphicalComponent.renderedPosition
    if (rendered) {
      this.aim.copy(rendered).y += AIM_HEIGHT + FOOT_OFFSET
    }
    else {
      this.direction.copy(this.player.position).y += AIM_HEIGHT
      this.aim.lerp(this.direction, 1 - Math.exp(-FOLLOW_RATE * delta))
    }

    this.view.copy(CHASE_OFFSET).applyAxisAngle(UP, this.chaseYaw).add(this.aim)
    // Turned only by chaseYaw, which changes only when the player turns the view
    Game.instance().camera.place(this.view, this.aim)
  }

  destroy() {
    const game = Game.instance()
    game.off('beforeRender', this.onFrame)
    game.off('xrSessionStart', this.onSessionStart)
    game.input.off('keydown', this.onKeydown)
    window.removeEventListener('mousemove', this.onMousemove)
  }
}
