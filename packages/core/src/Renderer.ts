import type { FpsGraphBladeApi } from '@tweakpane/plugin-essentials'
import type { Object3D, WebGLRendererParameters } from 'three'
import { Mesh, PCFSoftShadowMap, SkeletonHelper, SkinnedMesh, WebGLRenderer } from 'three'
import { ThreePerf } from 'three-perf'
import { EffectComposer, OutputPass, RenderPass } from 'three/examples/jsm/Addons.js'
import Game from './Game'
import SkeletonAxesHelper from './Utils/SkeletonAxesHelper'

export default class Renderer {
  instance: WebGLRenderer
  composer: EffectComposer
  fpsGraph: FpsGraphBladeApi | undefined

  options = {
    wireframe: false,
    perf: false,
    armature: false,
  }

  perf?: ThreePerf
  armatureHelpers: Object3D[] = []

  fps = 0
  private _fpsFrameCount = 0
  private _fpsElapsed = 0

  constructor(parameters?: WebGLRendererParameters) {
    this.instance = new WebGLRenderer(parameters)

    this.composer = new EffectComposer(this.instance)
    this.composer.addPass(
      new RenderPass(
        Game.instance().scene,
        Game.instance().camera.instance,
      ),
    )
    this.composer.addPass(new OutputPass())

    this.instance.shadowMap.enabled = true
    this.instance.shadowMap.type = PCFSoftShadowMap
    this.instance.setSize(
      Game.instance().sizes.width,
      Game.instance().sizes.height,
    )
    this.instance.setClearColor('#181818')
    this.instance.setPixelRatio(Game.instance().sizes.pixelRatio)
    this.composer.setPixelRatio(Game.instance().sizes.pixelRatio)
    this.composer.setSize(
      Game.instance().sizes.width,
      Game.instance().sizes.height,
    )

    const renderDebug = Game.instance().debug.ui?.addFolder({ title: 'Render' })

    if (renderDebug) {
      this.perf = new ThreePerf({
        anchorX: 'right',
        anchorY: 'bottom',
        memory: true,
        guiVisible: false,
        domElement: document.body,
        renderer: this.instance,
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

  resize() {
    this.instance.setSize(
      Game.instance().sizes.width,
      Game.instance().sizes.height,
    )
    this.instance.setPixelRatio(Game.instance().sizes.pixelRatio)
    this.composer.setPixelRatio(Game.instance().sizes.pixelRatio)
    this.composer.setSize(
      Game.instance().sizes.width,
      Game.instance().sizes.height,
    )
  }

  update(delta: number) {
    this.perf?.begin()
    this.composer.render(delta)
    this.perf?.end()

    this._fpsFrameCount++
    this._fpsElapsed += delta
    if (this._fpsElapsed >= 0.5) {
      this.fps = Math.round(this._fpsFrameCount / this._fpsElapsed)
      this._fpsFrameCount = 0
      this._fpsElapsed = 0
    }
  }
}
