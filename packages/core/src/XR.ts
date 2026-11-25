import type { Matrix4, WebGLRenderer, WebGLRenderTarget } from 'three'
import type Game from './Game'
import type Renderer from './Renderer'
import type { XRInputOptions } from './XRInput'
import type { XRLocomotionOptions } from './XRLocomotion'
import { PerspectiveCamera } from 'three'
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
  /**
   * Keep drawing the game in the browser window while a headset plays, from the player's head, e.g. for someone
   * watching or a stream. Renders the scene once more every frame. Off by default, toggled with `xr.mirror`
   */
  mirror?: boolean | XRMirrorOptions
}

export interface XRMirrorOptions {
  /** The mirror's vertical field of view, in degrees. Default 70 */
  fov?: number
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

  /** Whether the browser window shows the game while a headset plays. See `XROptions.mirror` */
  mirror: boolean

  /** The mirror's view: the player's head, shaped like the browser window */
  readonly mirrorCamera: PerspectiveCamera

  private readonly sessionInit: XRSessionInit

  /** The camera's field of view before the session, which three.js replaces with the headset's */
  private desktopFov?: number

  constructor(
    private readonly renderer: Renderer,
    private readonly game: Game,
    options: XROptions = {},
  ) {
    const xr = renderer.instance.xr
    xr.enabled = true
    patchRenderer(renderer.instance)
    xr.setReferenceSpaceType(options.referenceSpace ?? 'local-floor')

    this.sessionInit = {
      ...options.sessionInit,
      optionalFeatures: [
        'local-floor',
        'bounded-floor',
        ...(options.sessionInit?.optionalFeatures ?? []),
      ],
    }

    this.mirror = !!options.mirror
    this.mirrorCamera = new PerspectiveCamera(
      typeof options.mirror === 'object'
        ? options.mirror.fov ?? 70
        : 70,
      game.sizes.width / game.sizes.height,
    )

    xr.addEventListener('sessionstart', () => {
      this.desktopFov = game.camera.instance.fov
      game.trigger('xrSessionStart', xr.getSession())
    })
    xr.addEventListener('sessionend', () => {
      // three.js gave the camera the headset's field of view, which would stay on the desktop
      if (this.desktopFov !== undefined)
        game.camera.instance.fov = this.desktopFov
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

  /**
   * Draw the scene in the browser window from the player's head, after the headset's frame. Called by the renderer
   * every frame while presenting and `mirror` is on
   */
  renderMirror() {
    const webgl = this.renderer.instance
    const camera = this.game.camera.instance
    const near = camera.near
    const far = camera.far

    // The headset's frame placed the camera at the head: take its world pose, with the window's shape
    camera.matrixWorld.decompose(this.mirrorCamera.position, this.mirrorCamera.quaternion, this.mirrorCamera.scale)
    this.mirrorCamera.aspect = this.game.sizes.width / this.game.sizes.height
    this.mirrorCamera.near = near
    this.mirrorCamera.far = far
    this.mirrorCamera.updateProjectionMatrix()
    this.mirrorCamera.updateMatrixWorld(true)

    // With XR off for this one render, three.js draws to the page's canvas instead of the headset
    // The headset's frame already updated the shadow maps, so they're reused rather than rendered again
    const target = webgl.getRenderTarget()
    const shadowsAutoUpdate = webgl.shadowMap.autoUpdate
    webgl.xr.enabled = false
    webgl.shadowMap.autoUpdate = false
    try {
      webgl.setRenderTarget(null)
      webgl.render(this.game.scene, this.mirrorCamera)
    }
    finally {
      webgl.xr.enabled = true
      webgl.shadowMap.autoUpdate = shadowsAutoUpdate
      webgl.setRenderTarget(target)
    }
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

/**
 * Fixes for what three.js's WebXR leaves to the game:
 *
 * - **Reversed depth** (`reversedDepthBuffer: true`): three gives each eye the headset's projection, which maps depth
 *   the GL way (-1 near, 1 far). Seeing a reversed depth buffer the renderer takes the eyes for cameras not yet set up
 *   for it and recomputes their projection from their default 50 degree fov, once, and from then on renders the
 *   headset's GL projection into the reversed buffer: the depth test inverted, the far side drawn over the near.
 *   After three found the view's frustum from the GL projections (it reads the near and far planes off them), the
 *   eyes, and the game's camera that three gives their union, get the reversed form instead.
 * - **Off-screen renders**: while presenting, `render()` draws through the headset's cameras whatever it's given,
 *   into a render target too, e.g. an environment map, a lookup table or a mirror. Renders into a target that isn't
 *   the headset's render with the camera they were given, as three's own Reflector does it.
 */
function patchRenderer(renderer: WebGLRenderer) {
  const xr = renderer.xr
  const updateCamera = xr.updateCamera.bind(xr)
  xr.updateCamera = (camera: PerspectiveCamera) => {
    updateCamera(camera)
    if (!renderer.state.buffers.depth.getReversed())
      return
    for (const eye of xr.getCamera().cameras)
      reverseDepth(eye)
    reverseDepth(camera)
  }

  const render = renderer.render.bind(renderer)
  renderer.render = (scene, camera) => {
    const target = renderer.getRenderTarget() as (WebGLRenderTarget & { isXRRenderTarget?: boolean }) | null
    if (!xr.enabled || !xr.isPresenting || !target || target.isXRRenderTarget) {
      render(scene, camera)
      return
    }
    xr.enabled = false
    try {
      render(scene, camera)
    }
    finally {
      xr.enabled = true
    }
  }
}

/** Turn a camera's GL depth projection (as WebXR hands it out) into the reversed depth buffer's: 1 near, 0 far */
export function reverseDepth(camera: PerspectiveCamera) {
  // Marks it set up for reversed depth, so the renderer doesn't recompute the projection from fov and aspect
  ;(camera as unknown as { _reversedDepth: boolean })._reversedDepth = true
  reverseDepthMatrix(camera.projectionMatrix)
  camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert()
}

/** Only the z row changes: z becomes (w - z) / 2, so GL's -1 (near) .. 1 (far) maps to 1 .. 0 */
export function reverseDepthMatrix(m: Matrix4): Matrix4 {
  const e = m.elements
  for (const column of [0, 4, 8, 12])
    e[column + 2] = (e[column + 3] - e[column + 2]) / 2
  return m
}
