import type { AudioListener } from 'three'
import { PerspectiveCamera } from 'three'
import Game from './Game'

export default class Camera {
  instance: PerspectiveCamera

  constructor(audioListener: AudioListener) {
    this.instance = new PerspectiveCamera(
      35,
      Game.instance().sizes.width / Game.instance().sizes.height,
    )
    this.instance.add(audioListener)

    this.instance.position.set(6, 4, 8)
    Game.instance().scene.add(this.instance)
  }

  resize() {
    this.instance.aspect = Game.instance().sizes.width / Game.instance().sizes.height
    this.instance.updateProjectionMatrix()
  }

  update(_delta: number) {
  }
}
