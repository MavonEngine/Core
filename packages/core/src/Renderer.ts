import type { FpsGraphBladeApi } from '@tweakpane/plugin-essentials'
import type { Node, Object3D, WebGPURendererParameters } from 'three/webgpu'
import { Inspector } from 'three/examples/jsm/inspector/Inspector.js'
import { pass } from 'three/tsl'
import { Mesh, PCFShadowMap, RenderPipeline, SkeletonHelper, SkinnedMesh, WebGPURenderer } from 'three/webgpu'
import Game from './Game'
import FrameLimiter from './Utils/FrameLimiter'
import SkeletonAxesHelper from './Utils/SkeletonAxesHelper'

/**
 * A post-processing step: gets the picture so far (the scene, then each earlier effect) and returns the new one.
 * See `Renderer.addEffect()`
 */
export type RenderEffect = (input: Node<'vec4'>) => Node<'vec4'>

export type RendererParameters = WebGPURendererParameters

export default class Renderer {
  instance: WebGPURenderer
  /** Draws the scene pass through the effects added with `addEffect()`, then tone maps and converts the color space */
  pipeline: RenderPipeline
  /** The scene rendered from the game's camera: the effects' first input */
  scenePass: ReturnType<typeof pass>
  fpsGraph: FpsGraphBladeApi | undefined

  options = {
    wireframe: false,
    perf: false,
    armature: false,
  }

  /** three.js's inspector (frame timings, draw calls, memory), while `options.perf` is on */
  inspector?: Inspector
  armatureHelpers: Object3D[] = []

  fps = 0
  private frameLimiter = new FrameLimiter()
  private effects: { name: string, effect: RenderEffect }[] = []

  /**
   * The most frames to render per second, 0 for no limit. Only throttles rendering:
   * the game tick and physics keep running at `tickRate`.
   */
  get maxFps(): number {
    return this.frameLimiter.maxFps
  }

  set maxFps(value: number) {
    this.frameLimiter.maxFps = value
  }

  private _fpsFrameCount = 0
  private _fpsElapsed = 0

  constructor(parameters: RendererParameters = {}) {
    // WebGL 2 unless asked otherwise: the same devices as before, while the WebGPU backend gets tested
    this.instance = new WebGPURenderer({ forceWebGL: true, ...parameters })

    this.scenePass = pass(Game.instance().scene, Game.instance().camera.instance)
    this.pipeline = new RenderPipeline(this.instance, this.scenePass)

    this.instance.shadowMap.enabled = true
    this.instance.shadowMap.type = PCFShadowMap
    this.instance.setSize(
      Game.instance().sizes.width,
      Game.instance().sizes.height,
    )
    this.instance.setClearColor('#181818')
    this.instance.setPixelRatio(Game.instance().sizes.pixelRatio)
    // The pipeline renders several times a frame (the scene, the effects), so `info` counts whole frames: reset in
    // update() rather than by every render
    this.instance.info.autoReset = false

    const renderDebug = Game.instance().debug.ui?.addFolder({ title: 'Render' })

    if (renderDebug) {
      renderDebug.addBinding(this, 'maxFps', {
        label: 'max fps (0 = off)',
        min: 0,
        max: 240,
        step: 1,
      })

      renderDebug.addBinding(this.options, 'perf', { label: 'inspector' }).on('change', () => {
        this.setInspector(this.options.perf)
      })

      renderDebug.addBinding(this.options, 'wireframe').on('change', () => {
        Game.instance().scene.traverse((object) => {
          if (object instanceof Mesh && object.material) {
            object.material.wireframe = this.options.wireframe
          }
        })
      })

      renderDebug.addBinding(this.options, 'armature').on('change', () => {
        if (this.options.armature) {
          Game.instance().scene.traverse((object) => {
            if (object instanceof SkinnedMesh) {
              const skeletonHelper = new SkeletonHelper(object.skeleton.bones[0])
              const axesHelper = new SkeletonAxesHelper(object.skeleton.bones[0])

              Game.instance().scene.add(skeletonHelper, axesHelper)
              this.armatureHelpers.push(skeletonHelper, axesHelper)
            }
          })
        }
        else {
          for (const helper of this.armatureHelpers) {
            Game.instance().scene.remove(helper)
            if (helper instanceof SkeletonAxesHelper) {
              helper.dispose()
            }
          }
          this.armatureHelpers = []
        }
      })
    }
  }

  /** Whether the WebGPU backend renders, rather than the WebGL 2 fallback */
  get isWebGPU(): boolean {
    return (this.instance.backend as { isWebGPUBackend?: boolean }).isWebGPUBackend === true
  }

  /**
   * Add a post-processing step after the scene and the effects added before it. Adding one with a name that is taken
   * replaces it in place. Returns a function that removes it again.
   *
   * ```ts
   * renderer.addEffect('bloom', input => input.add(bloom(input)))
   * ```
   */
  addEffect(name: string, effect: RenderEffect): () => void {
    const entry = { name, effect }
    const index = this.effects.findIndex(e => e.name === name)
    if (index >= 0)
      this.effects[index] = entry
    else
      this.effects.push(entry)
    this.rebuildPipeline()

    return () => this.removeEffect(name, entry)
  }

  removeEffect(name: string, only?: { name: string, effect: RenderEffect }) {
    const index = this.effects.findIndex(e => e.name === name && (!only || e === only))
    if (index < 0)
      return
    this.effects.splice(index, 1)
    this.rebuildPipeline()
  }

  /** The names of the effects, in the order they apply */
  get effectNames(): string[] {
    return this.effects.map(e => e.name)
  }

  private rebuildPipeline() {
    let output = this.scenePass as unknown as Node<'vec4'>
    for (const { effect } of this.effects)
      output = effect(output)
    this.pipeline.outputNode = output
    this.pipeline.needsUpdate = true
  }

  private setInspector(visible: boolean) {
    if (visible && !this.inspector) {
      this.inspector = new Inspector()
      this.instance.inspector = this.inspector
    }
    this.inspector?.setVisible(visible)
  }

  /** Whether a WebXR session is rendering to a headset */
  get xrPresenting(): boolean {
    return this.instance.xr.isPresenting
  }

  resize() {
    // The XR session owns the framebuffer size, and three.js ignores setSize while presenting.
    // The game resizes again once the session ends
    if (this.xrPresenting)
      return

    this.instance.setSize(
      Game.instance().sizes.width,
      Game.instance().sizes.height,
    )
    this.instance.setPixelRatio(Game.instance().sizes.pixelRatio)
  }

  /**
   * @param now the frame's timestamp in ms
   * @returns whether this frame should be rendered under `maxFps`
   */
  shouldRender(now: number): boolean {
    // The headset sets the frame rate, and skipping its frames judders the view
    if (this.xrPresenting)
      return true

    return this.frameLimiter.shouldRender(now)
  }

  /** Draw one frame: through the pipeline, or straight to the headset in XR */
  render() {
    if (this.xrPresenting) {
      // The pipeline renders a single view, so in XR render straight to the headset's stereo cameras.
      // The renderer's toneMapping and outputColorSpace stand in for the pipeline's output transform
      this.instance.render(Game.instance().scene, Game.instance().camera.instance)
      // The browser window otherwise stays on its last frame (black, mostly) while the headset plays
      const xr = Game.instance().xr
      if (xr?.mirror)
        xr.renderMirror()
    }
    else {
      this.pipeline.render()
    }
  }

  update(delta: number) {
    this.instance.info.reset()
    // Before rendering so uniforms holding it (rain, smoke) see this frame's camera
    Game.instance().camera.updateWorldPosition()
    this.render()
    Game.instance().camera.afterRender()

    this._fpsFrameCount++
    this._fpsElapsed += delta
    if (this._fpsElapsed >= 0.5) {
      this.fps = Math.round(this._fpsFrameCount / this._fpsElapsed)
      this._fpsFrameCount = 0
      this._fpsElapsed = 0
    }
  }
}
