import type { Texture } from 'three'
import { CameraHelper, DirectionalLight, DirectionalLightHelper } from 'three'
import Game from '../Game'

export default class Environment {
  sunLight: DirectionalLight

  constructor() {
    this.sunLight = new DirectionalLight('#ffffff', 1)
    this.sunLight.castShadow = true
    this.sunLight.shadow.mapSize.set(2048, 2048)
    this.sunLight.shadow.normalBias = 0.05
    this.sunLight.position.set(0, 20, 40)

    this.sunLight.shadow.camera.left = -50
    this.sunLight.shadow.camera.right = 50
    this.sunLight.shadow.camera.top = 50
    this.sunLight.shadow.camera.bottom = -50
    this.sunLight.shadow.camera.far = 100

    this.sunLight.shadow.camera.updateProjectionMatrix() // Make sure it updates

    if (Game.instance().debug.active) {
      Game.instance().scene.add(new DirectionalLightHelper(this.sunLight))
      Game.instance().scene.add(new CameraHelper(this.sunLight.shadow.camera))
    }

    Game.instance().scene.add(this.sunLight)
  }

  public setEnvironmentMap(texture: Texture, intensity: number) {
    Game.instance().scene.environment = texture
    Game.instance().scene.environmentIntensity = intensity
  }
}
