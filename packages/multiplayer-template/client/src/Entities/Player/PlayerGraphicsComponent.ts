import type Character from '../Player'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import Game from '@mavonengine/core/Game'
import Entity3D from '@mavonengine/core/World/Entity3D'

export default class PlayerGraphicsComponent extends Entity3D {
  private player: Character

  constructor(player: Character) {
    super()
    this.player = player
  }

  init() {
    const onLoaded = () => {
      this.initModel(Game.instance().resources.items.character as GLTF)

      // Re-enter the current state so animations start now that the model is ready
      const currentState = this.player.state[this.player.state.length - 1]
      currentState?.enter()
    }

    if (Game.instance().resources.loaded) {
      onLoaded()
    }
    else {
      Game.instance().resources.on('loaded', onLoaded)
    }
  }

  update(delta: number): void {
    if (this.instance) {
      this.instance.position.set(
        this.player.position.x,
        this.player.position.y - 0.8,
        this.player.position.z,
      )
      this.instance.rotation.y = this.player.rotation.y + Math.PI
    }

    super.update(delta)
  }
}
