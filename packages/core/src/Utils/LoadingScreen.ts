import type { BufferGeometry } from 'three'
import type { ResourceLoadingProgress } from '../Types/Events'
import type Resources from './Resources'
import { Mesh, PlaneGeometry, ShaderMaterial } from 'three'
import Game from '../Game'
import FragmentShader from '../Particles/Shaders/LoadingScreen/Fragment.glsl'
import VertextShader from '../Particles/Shaders/LoadingScreen/Vertex.glsl'
import EventEmitter from './EventEmitter'

export default class LoadingScreen extends EventEmitter {
  private overlay: Mesh<BufferGeometry, ShaderMaterial> | undefined

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
      const overlayMaterial = new ShaderMaterial({
        vertexShader: VertextShader,
        fragmentShader: FragmentShader,
        transparent: true,
        uniforms: {
          uAlpha: { value: 1.0 },
        },
      })

      this.overlay = new Mesh(overlayGeometry, overlayMaterial)
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
      this.progress = this.overlay!.material.uniforms.uAlpha.value = 1 - progress
      Game.instance().uiRoot.style.opacity = `${progress}`

      // Optional: remove overlay from scene after fade completes
      if (progress >= 1) {
        Game.instance().scene.remove(this.overlay!)
      }
    }
  }
}
