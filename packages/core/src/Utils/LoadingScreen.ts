import type { BufferGeometry } from 'three'
import type { ResourceLoadingProgress } from '../Types/Events'
import type Resources from './Resources'
import { positionGeometry, uniform, vec4 } from 'three/tsl'
import { Mesh, MeshBasicNodeMaterial, PlaneGeometry } from 'three/webgpu'
import Game from '../Game'
import EventEmitter from './EventEmitter'

export default class LoadingScreen extends EventEmitter {
  private overlay: Mesh<BufferGeometry, MeshBasicNodeMaterial> | undefined
  private readonly uAlpha = uniform(1.0)

  loaded = false
  progress = 0
  duration = 2

  private fadeStartTime: number | null = null

  loadingBar: HTMLDivElement | undefined

  constructor(resources: Resources) {
    super()

    Game.instance().on('uiMounted', () => {
      this.loadingBar = document.getElementById('loadingBar') as HTMLDivElement

      const overlayGeometry = new PlaneGeometry(2, 2, 1, 1)
      // A black quad over the whole view, in clip space
      const overlayMaterial = new MeshBasicNodeMaterial({ transparent: true, fog: false })
      overlayMaterial.vertexNode = vec4(positionGeometry, 1.0)
      overlayMaterial.fragmentNode = vec4(0, 0, 0, this.uAlpha)

      this.overlay = new Mesh(overlayGeometry, overlayMaterial)
      // Its geometry is placed in clip space, where the camera's frustum would cull it
      this.overlay.frustumCulled = false
      Game.instance().scene.add(this.overlay)

      resources.on('loaded', () => {
        this.loaded = true
        this.fadeStartTime = 0

        setTimeout(() => {
          this.loadingBar!.classList.add('ended')
          this.loadingBar!.style.transform = ''
          Game.instance().uiRoot.style.removeProperty('visibility')
        }, 500)
      })

      resources.on('progress', (evt) => {
        const event = evt as ResourceLoadingProgress
        const progress = event.loaded / event.total

        this.loadingBar!.style.transform = `scaleX(${progress})`
      })
    })
  }

  update(delta: number) {
    if (!this.loaded)
      return

    if (this.fadeStartTime === 0) {
      this.fadeStartTime = 0.0001 // ensure it's initialized and starts fading
    }

    if (this.fadeStartTime !== null) {
      this.fadeStartTime += delta

      const progress = Math.min(this.fadeStartTime / this.duration, 1)
      this.progress = this.uAlpha.value = 1 - progress
      Game.instance().uiRoot.style.opacity = `${progress}`

      // Optional: remove overlay from scene after fade completes
      if (progress >= 1) {
        Game.instance().scene.remove(this.overlay!)
      }
    }
  }
}
