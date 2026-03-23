import type { Object3D } from 'three/webgpu'
import { WebGLRenderer } from 'three'
import { Box3, DirectionalLight, PerspectiveCamera, Scene, Vector3 } from 'three/webgpu'
import Game from '../Game'

export default class AssetRenderer {
  item

  static previewScene = new Scene()
  static previewRenderer = new WebGLRenderer({ alpha: true })
  static previewCamera = new PerspectiveCamera(50, 1, 0, 10)
  static initialized = false

  constructor(key: string) {
    this.item = Game.instance().resources.items[key]
    this.initRenderer()

    if ('scene' in this.item) {
      AssetRenderer.previewScene.add(this.item.scene)
      this.adjustCameraToModel(this.item.scene)
    }
  }

  initRenderer() {
    if (AssetRenderer.initialized)
      return

    AssetRenderer.previewRenderer.setSize(100, 100)

    const light = new DirectionalLight(0xFFFFFF, 3)
    light.position.set(5, 5, 5)
    AssetRenderer.previewScene.add(light)

    const ambientLight = new DirectionalLight(0xFFFFFF, 4)
    ambientLight.position.set(-5, -5, -5)
    AssetRenderer.previewScene.add(ambientLight)

    AssetRenderer.initialized = true
  }

  adjustCameraToModel(model: Object3D) {
    const box = new Box3().setFromObject(model)
    const size = new Vector3()
    const center = new Vector3()
    box.getSize(size)
    box.getCenter(center)

    const maxDim = Math.max(size.x, size.y, size.z)
    const fov = AssetRenderer.previewCamera.fov * (Math.PI / 180)
    const cameraZ = maxDim / (2 * Math.tan(fov / 2))

    AssetRenderer.previewCamera.position.set(center.x, center.y, center.z + cameraZ * 1.5)
    AssetRenderer.previewCamera.lookAt(center)
    AssetRenderer.previewCamera.near = 0.1
    AssetRenderer.previewCamera.far = cameraZ + maxDim * 2
    AssetRenderer.previewCamera.updateProjectionMatrix()
  }

  render() {
    if ('scene' in this.item === false)
      return

    AssetRenderer.previewRenderer.render(AssetRenderer.previewScene, AssetRenderer.previewCamera)
    AssetRenderer.previewScene.remove(this.item.scene)

    return AssetRenderer.previewRenderer.domElement.toDataURL()
  }
}
