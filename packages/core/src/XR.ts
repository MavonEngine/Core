import type Game from './Game'
import type Renderer from './Renderer'
import type { XRInputOptions } from './XRInput'
import type { XRLocomotionOptions } from './XRLocomotion'
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js'
import XRInput from './XRInput'
import XRLocomotion from './XRLocomotion'

export interface XROptions {
  /**
   * Where the headset's origin sits. 'local-floor' (the default) puts it on the floor under the player,
   * 'local' at their head height when the session started
   */
  referenceSpace?: XRReferenceSpaceType
  /** Show three.js's "Enter VR" button. Set to false to call `enter()` from your own UI instead */
  button?: boolean
  /** Extra features for the session, e.g. `{ optionalFeatures: ['hand-tracking'] }` */
  sessionInit?: XRSessionInit
  /** How the controllers show, or false to leave controller input out */
  input?: XRInputOptions | false
}

/**
 * Plays the game in a VR headset through WebXR. Created by `Game.enableXR()`.
 *
 * While a session runs, the headset drives `camera.instance`'s position and rotation, rendering skips the
 * EffectComposer and `renderer.maxFps` is ignored.
 */
export default class XR {
  /** The "Enter VR" button, unless `button: false` was passed */
  readonly button?: HTMLElement

  /** The controllers, also at `game.input.xr` */
  readonly input?: XRInput

  /** Thumbstick movement, once `enableLocomotion()` was called */
  locomotion?: XRLocomotion

  private readonly sessionInit: XRSessionInit

  constructor(
    private readonly renderer: Renderer,
    private readonly game: Game,
    options: XROptions = {},
  ) {
    const xr = renderer.instance.xr
    xr.enabled = true
    xr.setReferenceSpaceType(options.referenceSpace ?? 'local-floor')

    this.sessionInit = {
      ...options.sessionInit,
      optionalFeatures: [
        'local-floor',
        'bounded-floor',
        ...(options.sessionInit?.optionalFeatures ?? []),
      ],
    }

    xr.addEventListener('sessionstart', () => game.trigger('xrSessionStart', xr.getSession()))
    xr.addEventListener('sessionend', () => {
      // Resizes were skipped while presenting, so catch up with the window
      game.sizes.setSize(window.innerWidth, window.innerHeight)
      // Hand the camera back to desktop controls that move it directly (orbit, fly), without the VR offset and
      // turns. Games placing the view with camera.place() place it again anyway
      game.camera.rig.position.set(0, 0, 0)
      game.camera.rig.quaternion.identity()
      game.trigger('xrSessionEnd')
    })

    if (options.input !== false) {
      this.input = new XRInput(xr, game.camera.rig, options.input)
      game.input.xr = this.input
    }

    if (options.button !== false) {
      this.button = VRButton.createButton(renderer.instance, options.sessionInit)
      document.body.appendChild(this.button)
    }
  }

  /**
   * Let the player walk with one thumbstick and turn with the other, by moving the camera rig. Only while in VR,
   * and every rendered frame so the movement is smooth. For free roaming games: it doesn't collide with anything.
   */
  enableLocomotion(options?: XRLocomotionOptions): XRLocomotion {
    if (!this.input)
      throw new Error('Locomotion needs the controllers: enableXR() was called with input: false')

    if (!this.locomotion) {
      const locomotion = new XRLocomotion(this.game.camera, this.input, options)
      this.game.on('beforeRender', (delta: number) => {
        if (this.presenting)
          locomotion.update(delta)
      })
      this.locomotion = locomotion
    }
    return this.locomotion
  }

  /** Whether this browser and device can run immersive VR */
  static async isSupported(): Promise<boolean> {
    if (typeof navigator === 'undefined' || !navigator.xr)
      return false
    return navigator.xr.isSessionSupported('immersive-vr').catch(() => false)
  }

  /** Whether a session is rendering to the headset */
  get presenting(): boolean {
    return this.renderer.xrPresenting
  }

  /** The running session, if any */
  get session(): XRSession | null {
    return this.renderer.instance.xr.getSession()
  }

  /** Start a VR session. Browsers only allow this from a user gesture, like a click */
  async enter(): Promise<XRSession> {
    if (!navigator.xr)
      throw new Error('WebXR is not available. It needs a secure context (https or localhost) and a supporting browser')

    const session = await navigator.xr.requestSession('immersive-vr', this.sessionInit)
    await this.renderer.instance.xr.setSession(session)
    return session
  }

  /** End the running session, if any */
  async exit(): Promise<void> {
    await this.session?.end()
  }

  dispose() {
    this.button?.remove()
  }
}
