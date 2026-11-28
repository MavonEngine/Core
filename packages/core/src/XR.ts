import type { Light, LightShadow, Matrix4 } from 'three'
import type { WebGPURenderer } from 'three/webgpu'
import type Game from './Game'
import type Renderer from './Renderer'
import type XRPanel from './ui/XRPanel'
import type { XRInputOptions } from './XRInput'
import type { XRLocomotionOptions } from './XRLocomotion'
import { PerspectiveCamera, Vector4 } from 'three'
import { VRButton } from 'three/examples/jsm/webxr/VRButton.js'
import XRInput from './XRInput'
import XRLocomotion from './XRLocomotion'
import XRPointer from './XRPointer'

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
   * watching or a stream. Renders the scene once more every frame. Off by default, toggled with `xr.mirror`.
   * It costs the headset frames: three.js rebuilds every object's render pipeline each time the camera changes
   * between the headset's eyes and the mirror's (a Valve Index in Chrome on Windows ran at 45 Hz with it, at 90
   * without). Without it, the window shows its last frame, blurred, saying the game is playing in VR
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
 * render pipeline and `renderer.maxFps` is ignored.
 */
export default class XR {
  /** The "Enter VR" button, unless `button: false` was passed */
  readonly button?: HTMLElement

  /** The controllers, also at `game.input.xr` */
  readonly input?: XRInput

  /** The controllers pointing at panels (addPanel), unless `input: false` was passed */
  readonly pointer?: XRPointer

  /** The panels added with `addPanel()` */
  readonly panels = new Set<XRPanel>()

  /** Thumbstick movement, once `enableLocomotion()` was called */
  locomotion?: XRLocomotion

  /** Whether the browser window shows the game while a headset plays. See `XROptions.mirror` */
  mirror: boolean

  /** The mirror's view: the player's head, shaped like the browser window */
  readonly mirrorCamera: PerspectiveCamera

  private readonly sessionInit: XRSessionInit

  /** The camera's field of view before the session, which three.js replaces with the headset's */
  private desktopFov?: number

  /** Over the page's canvas while a headset plays without the mirror: its last frame, blurred, saying so */
  private backdrop?: HTMLElement

  constructor(
    private readonly renderer: Renderer,
    private readonly game: Game,
    options: XROptions = {},
  ) {
    const xr = renderer.instance.xr
    xr.enabled = true
    patchRenderer(renderer.instance)
    xr.setReferenceSpaceType(options.referenceSpace ?? 'local-floor')

    // Taken before three.js has the session: it resizes the canvas for the headset, which clears it
    const setSession = xr.setSession.bind(xr)
    xr.setSession = (session: XRSession) => {
      if (session && !this.mirror)
        this.showBackdrop()
      return setSession(session)
    }

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
      this.hideBackdrop()
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
      this.pointer = new XRPointer(this.input, () => this.panels)
    }

    // The panels every rendered frame: shown while in VR and open, kept in front of the head, pointed at
    game.on('beforeRender', (delta: number) => {
      if (!this.panels.size)
        return
      const presenting = this.presenting
      for (const panel of this.panels)
        panel.update(game.camera.instance, presenting, delta)
      if (presenting)
        this.pointer?.update()
    })

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
   * Show a panel in VR (see XRPanel): placed in the camera rig, so it moves with the player, and pointed at with
   * the controllers. It shows while presenting and `panel.open()`
   */
  addPanel(panel: XRPanel): XRPanel {
    this.panels.add(panel)
    this.game.camera.rig.add(panel.mesh)
    return panel
  }

  removePanel(panel: XRPanel) {
    this.panels.delete(panel)
    panel.mesh.removeFromParent()
  }

  /**
   * Draw the scene in the browser window from the player's head, after the headset's frame. Called by the renderer
   * every frame while presenting and `mirror` is on
   */
  renderMirror() {
    // Turned on during the session: the mirror shows instead
    this.hideBackdrop()
    const three = this.renderer.instance
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
    const target = three.getRenderTarget()
    const shadows: LightShadow[] = []
    this.game.scene.traverseVisible((object) => {
      const light = object as Light & { shadow?: LightShadow }
      const shadow = light.shadow
      if (light.isLight && light.castShadow && shadow?.autoUpdate) {
        shadow.autoUpdate = false
        shadows.push(shadow)
      }
    })
    // The session points the renderer's output render target at the headset's, which is drawn to whatever the render
    // target, and gives the canvas the headset's size: the mirror would be drawn over both eyes. For this one render,
    // the output is the canvas again, at its own size
    const output = three.getOutputRenderTarget()
    const canvas = (three as unknown as { _canvasTarget: { _width: number, _height: number } })._canvasTarget
    const headsetSize = { width: canvas._width, height: canvas._height }
    const viewport = three.getViewport(new Vector4())
    three.xr.enabled = false
    try {
      three.setOutputRenderTarget(null)
      canvas._width = three.domElement.width
      canvas._height = three.domElement.height
      three.setViewport(0, 0, canvas._width, canvas._height)
      three.setRenderTarget(null)
      three.render(this.game.scene, this.mirrorCamera)
    }
    finally {
      three.xr.enabled = true
      for (const shadow of shadows)
        shadow.autoUpdate = true
      canvas._width = headsetSize.width
      canvas._height = headsetSize.height
      three.setViewport(viewport)
      three.setOutputRenderTarget(output)
      three.setRenderTarget(target)
    }
  }

  /**
   * Cover the page's canvas with its last frame, blurred, saying the game plays in VR: otherwise it stays on a
   * cleared canvas while the headset plays. Placed before the UI root, so the game's UI still shows over it
   */
  private showBackdrop() {
    this.hideBackdrop()
    const canvas = this.game.canvas
    // A frame drawn now and copied in the same task: WebGL clears the canvas once a frame is shown. Small, as it's
    // blurred anyway
    this.renderer.render()
    const snapshot = document.createElement('canvas')
    snapshot.width = Math.max(1, Math.round(canvas.width / 4))
    snapshot.height = Math.max(1, Math.round(canvas.height / 4))
    snapshot.getContext('2d')?.drawImage(canvas, 0, 0, snapshot.width, snapshot.height)
    snapshot.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;filter:blur(12px) brightness(0.55);transform:scale(1.06)'

    const label = document.createElement('div')
    label.textContent = 'Playing in VR'
    label.style.cssText = 'position:absolute;inset:0;display:flex;align-items:center;justify-content:center;color:#fff;font:600 32px system-ui,sans-serif;letter-spacing:0.04em;text-shadow:0 2px 12px rgba(0,0,0,0.5)'

    const backdrop = document.createElement('div')
    backdrop.className = 'xr-backdrop'
    backdrop.style.cssText = 'position:fixed;inset:0;overflow:hidden;pointer-events:none;background:#111'
    backdrop.append(snapshot, label)
    this.game.uiRoot.before(backdrop)
    this.backdrop = backdrop
  }

  private hideBackdrop() {
    this.backdrop?.remove()
    this.backdrop = undefined
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
    this.pointer?.dispose()
    for (const panel of this.panels)
      this.removePanel(panel)
  }
}

/**
 * Fixes for what three.js's WebXR leaves to the game, with a reversed depth buffer (`reversedDepthBuffer: true`):
 *
 * - **The eyes' projection**: three gives each eye the headset's projection, which maps depth the GL way (-1 near,
 *   1 far), and renders it into the reversed buffer as it is: the depth test inverted, the far side drawn over the
 *   near. After three found the view's frustum from the GL projections (it reads the near and far planes off them),
 *   the eyes, and the game's camera that three gives their union, get the reversed form instead.
 * - **Reversed depth for the compositor**: the headset reads the depth buffer to correct the picture for the head's
 *   movement since it was rendered (positional timewarp, space warp), by the session's depthNear and depthFar. Read
 *   the GL way, a reversed buffer puts the far landscape right at the eyes, and it jitters as the head moves. The
 *   session is given them swapped (WebXR lets depthNear be the larger), which is how reversed depth reads, and the
 *   headset's projections come with the near plane at +1: they're turned the GL way for three first.
 *
 * Renders into a render target while presenting (environment maps, mirrors) need no fix: the renderer only uses the
 * headset's cameras for the canvas.
 *
 * And, with any depth buffer:
 *
 * - **Layers only when granted**: three draws to the headset through a WebXR Layers projection layer wherever the
 *   browser has the API (XRWebGLBinding.createProjectionLayer), whether or not the session was given the 'layers'
 *   feature (three's #30112). Chrome on Windows (158, SteamVR) has the API but doesn't grant the feature: the layer is
 *   taken, no frame ever comes and SteamVR says the page isn't responding. A session without the feature gets the
 *   WebGL layer (XRWebGLLayer) instead.
 */
function patchRenderer(renderer: WebGPURenderer) {
  const xr = renderer.xr

  // three decides once, when the renderer is made, and reads it again every frame: so it's set for each session
  const layers = xr as unknown as { _supportsLayers: boolean }
  const supportsLayers = layers._supportsLayers
  const setSession = xr.setSession.bind(xr)
  xr.setSession = (session: XRSession) => {
    if (session)
      layers._supportsLayers = supportsLayers && !!session.enabledFeatures?.includes('layers')
    return setSession(session)
  }

  const updateCamera = xr.updateCamera.bind(xr)
  // The eyes' GL projections this frame, as three reads them: updateCamera can run more than once a frame
  let frame: XRFrame | null = null
  const glEyes: Matrix4[] = []
  let requested = ''

  xr.updateCamera = (camera: PerspectiveCamera) => {
    if (!renderer.reversedDepthBuffer) {
      updateCamera(camera)
      return
    }

    const eyes = xr.getCamera().cameras as PerspectiveCamera[]
    if (xr.getFrame() !== frame) {
      frame = xr.getFrame()
      eyes.forEach((eye, i) => (glEyes[i] ??= eye.projectionMatrix.clone()).copy(glDepthOrder(eye.projectionMatrix, camera.near)))
    }
    eyes.forEach((eye, i) => eye.projectionMatrix.copy(glEyes[i]))
    updateCamera(camera)
    for (const eye of eyes)
      reverseDepth(eye)
    reverseDepth(camera)

    // After three's own updateRenderState (sent when the camera's planes change), so this one wins
    const session = xr.getSession()
    const planes = `${camera.far}|${camera.near}`
    if (session && planes !== requested) {
      session.updateRenderState({ depthNear: camera.far, depthFar: camera.near })
      requested = planes
    }
  }
  xr.addEventListener('sessionend', () => {
    frame = null
    requested = ''
  })

  // The headset's layer may draw to the default framebuffer: WebXR gives its framebuffer as null then (emulators do,
  // like iwer). three's WebGL backend keys its draw buffer state by the framebuffer and throws on null. The default
  // framebuffer only has the back buffer, which is what it sets up for no render target, so null goes that way
  xr.addEventListener('sessionstart', () => {
    const state = (renderer.backend as { state?: GLDrawBufferState } | undefined)?.state
    if (!state || state.drawBuffers.allowsNullFramebuffer)
      return
    const drawBuffers = state.drawBuffers.bind(state)
    const patched = ((context, framebuffer) => framebuffer
      ? drawBuffers(context, framebuffer)
      : drawBuffers({ ...context, textures: null }, framebuffer)) as GLDrawBufferState['drawBuffers']
    patched.allowsNullFramebuffer = true
    state.drawBuffers = patched
  })
}

/** The part of three's WebGL backend state that sets which buffers a framebuffer draws to */
interface GLDrawBufferState {
  drawBuffers: ((context: { textures: unknown }, framebuffer: WebGLFramebuffer | null) => void) & { allowsNullFramebuffer?: boolean }
}

/**
 * A headset's projection in GL's order (-1 at the near plane, 1 at the far one). Given the planes swapped, the headset
 * puts the near one at +1: the same projection with z negated. Told by where the near plane lands, in case a browser
 * didn't take the swap.
 */
export function glDepthOrder(m: Matrix4, near: number): Matrix4 {
  const e = m.elements
  const z = -e[10] * near + e[14]
  const w = -e[11] * near + e[15]
  if (z / w > 0) {
    for (const column of [0, 4, 8, 12])
      e[column + 2] = -e[column + 2]
  }
  return m
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
