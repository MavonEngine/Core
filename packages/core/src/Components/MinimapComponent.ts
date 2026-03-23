import type { OrthographicCamera } from 'three'
import type { Font } from 'three/examples/jsm/Addons.js'
import type GameObject from '../World/GameObject'
import type GameObjectInterface from '../World/GameObjectInterface'
import { Mesh, MeshBasicMaterial, Vector3, WebGLRenderer } from 'three'
import { TextGeometry } from 'three/examples/jsm/Addons.js'
import Game from '../Game'

export const MINIMAP_LAYER = 31

export default class MinimapComponent implements GameObjectInterface {
  minimapElement: HTMLCanvasElement
  camera: OrthographicCamera
  renderer: WebGLRenderer

  target?: GameObject
  northIcon?: Mesh

  constructor(minimapElement: HTMLCanvasElement, camera: OrthographicCamera, target?: GameObject) {
    this.minimapElement = minimapElement
    this.camera = camera
    this.camera.position.set(0, 10, 0)
    this.camera.lookAt(0, 0, 0)
    this.camera.layers.set(MINIMAP_LAYER)

    this.renderer = new WebGLRenderer({
      canvas: this.minimapElement,
      antialias: true,
      alpha: true,
    })
    this.renderer.setPixelRatio(Game.instance().sizes.pixelRatio)
    this.renderer.setSize(250, 250)
    this.camera.up.set(0, 0, 1)

    const load = () => {
      const geometry = new TextGeometry('N', {
        font: Game.instance().resources.items.font as unknown as Font,
        size: 3,
        depth: 0.1,
      })

      const material = new MeshBasicMaterial({ color: 'white' })
      this.northIcon = new Mesh(geometry, material)
      this.northIcon.rotateX(-90 * Math.PI / 180)
      this.northIcon.layers.set(MINIMAP_LAYER)

      Game.instance().scene.add(this.northIcon)
    }

    if (Game.instance().resources.loaded) {
      load()
    }
    else {
      Game.instance().resources.on('loaded', load)
    }

    this.target = target
  }

  update(_delta: number) {
    if (this.target && this.northIcon) {
      const targetPos = this.target.position

      // Position camera above target
      this.camera.position.set(targetPos.x, 10, targetPos.z)

      // Position "N" north of the target
      const northOffset = 19
      const northPos = new Vector3(targetPos.x, targetPos.y, targetPos.z + northOffset)
      this.northIcon.position.copy(northPos)
    }

    this.renderer.render(Game.instance().scene, this.camera)
  }

  destroy() {
    this.renderer.dispose()
    Game.instance().scene.remove(this.northIcon!)
    this.northIcon?.geometry.dispose()
  }
}
