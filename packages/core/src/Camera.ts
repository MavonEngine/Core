import type { AudioListener } from 'three'
import { Group, Matrix4, PerspectiveCamera, Vector3 } from 'three'
import Game from './Game'

const UP = new Vector3(0, 1, 0)
const lookMatrix = new Matrix4()
const flatTarget = new Vector3()
const headOffset = new Vector3()
const pivot = new Vector3()

/** Where the head is assumed to be above the rig's floor until the headset's first pose is known */
const DEFAULT_EYE_HEIGHT = 1.6

export default class Camera {
  instance: PerspectiveCamera

  /**
   * The camera's parent. In VR the headset drives `instance` relative to this rig, so games move the player's
   * view by moving the rig (or with `place()`) instead of the camera. On desktop the rig stays at the origin
   * unless moved, so setting `instance`'s position directly keeps working there.
   */
  readonly rig = new Group()

  /**
   * Where the camera is in the world, for distance checks and shader uniforms. `instance.position` is relative
   * to the rig, so it isn't the world position once the rig moves. Refreshed every rendered frame and the
   * same Vector3 throughout, so it can be handed to a uniform once.
   */
  readonly worldPosition = new Vector3()

  /**
   * The head's offset from the rig that `place()` keeps lined up with its position in VR, measured once per
   * session (see `recenter()`) so the player's own head movement still moves the view
   */
  private xrHeadOffset?: Vector3

  constructor(audioListener: AudioListener) {
    this.instance = new PerspectiveCamera(
      35,
      Game.instance().sizes.width / Game.instance().sizes.height,
    )
    this.instance.add(audioListener)

    this.instance.position.set(6, 4, 8)
    this.rig.name = 'CameraRig'
    this.rig.add(this.instance)
    Game.instance().scene.add(this.rig)
    this.updateWorldPosition()
  }

  /** Whether a VR headset drives the camera */
  get xrPresenting(): boolean {
    return Game.instance().renderer?.xrPresenting ?? false
  }

  /**
   * Put the view at `position` looking at `target`, e.g. a third person camera behind the player.
   * Works the same on desktop and in VR, so a game doesn't need its own VR camera code:
   *
   * - desktop: moves the rig there and turns it to look at the target, with `instance` left at the rig's origin
   * - VR: moves the rig so the player's head lands at `position` and only turns it around the vertical axis.
   *   The headset keeps control of where the player looks, and tilting the rig would tilt the world.
   *
   * Turning the view continuously in VR is uncomfortable for many players, so pass `turn: false` to only move the
   * rig and leave its heading alone (turn it yourself in steps, e.g. 30 degree snap turns).
   */
  place(position: Vector3, target: Vector3, { turn = true }: { turn?: boolean } = {}) {
    if (!this.xrPresenting) {
      this.instance.position.set(0, 0, 0)
      this.instance.quaternion.identity()
      this.rig.position.copy(position)
      if (turn) {
        lookMatrix.lookAt(position, target, UP)
        this.rig.quaternion.setFromRotationMatrix(lookMatrix)
      }
      this.updateWorldPosition()
      return
    }

    if (turn) {
      flatTarget.set(target.x, position.y, target.z)
      if (flatTarget.distanceToSquared(position) > 1e-8) {
        lookMatrix.lookAt(position, flatTarget, UP)
        this.rig.quaternion.setFromRotationMatrix(lookMatrix)
      }
    }

    // The head sits above the rig's floor level (and wherever the player stood when the session began), so move
    // the rig by that offset to land the head at `position`
    headOffset.copy(this.xrHeadOffset ?? { x: 0, y: DEFAULT_EYE_HEIGHT, z: 0 }).applyQuaternion(this.rig.quaternion)
    this.rig.position.copy(position).sub(headOffset)
    this.updateWorldPosition()
  }

  /**
   * Turn the view around the vertical axis through the player's head, e.g. a snap turn on a thumbstick flick.
   * Positive turns left. Works on desktop too, where it turns the rig around the camera.
   */
  turn(angle: number) {
    this.updateWorldPosition()
    pivot.copy(this.worldPosition)
    this.rig.position.sub(pivot).applyAxisAngle(UP, angle).add(pivot)
    this.rig.rotateOnWorldAxis(UP, angle)
    this.updateWorldPosition()
  }

  /**
   * Take the headset's current offset from the rig as the one `place()` lines up with its position, e.g. after the
   * player sits down or walks to another spot in their room. Done on the first rendered frame of each VR session.
   */
  recenter() {
    this.xrHeadOffset = this.instance.position.clone()
  }

  /**
   * Called by the renderer after each frame. The headset pose is only known once a VR frame rendered,
   * so that's where the session's head offset is measured.
   */
  afterRender() {
    if (!this.xrPresenting) {
      this.xrHeadOffset = undefined
      return
    }

    if (!this.xrHeadOffset)
      this.recenter()
  }

  /** Refresh `worldPosition` from the rig and the camera */
  updateWorldPosition() {
    this.instance.getWorldPosition(this.worldPosition)
  }

  resize() {
    this.instance.aspect = Game.instance().sizes.width / Game.instance().sizes.height
    this.instance.updateProjectionMatrix()
  }

  update(_delta: number) {
  }
}
