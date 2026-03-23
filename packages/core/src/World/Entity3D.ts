import type { AnimationAction, Group, Object3DEventMap } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { AnimationMixer, Mesh } from 'three'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import Game from '../Game'
import Actor from './Actor'

/**
 * An object in the game world with an Object3D (or Mesh).
 */
export default class Entity3D extends Actor {
  instance!: Group<Object3DEventMap>

  animationMixer?: AnimationMixer
  animationsMap = new Map<string, AnimationAction>()
  previousAction?: AnimationAction
  activeAction?: AnimationAction

  protected initModel(model: GLTF) {
    this.instance = clone(model.scene) as Group<Object3DEventMap>

    this.instance.traverse((o) => {
      if (o instanceof Mesh) {
        o.castShadow = true
        o.receiveShadow = true

        const geometry = o.geometry
        geometry.computeBoundingBox()
        geometry.computeBoundingSphere()

        if (geometry.boundingBox) {
          geometry.boundingBox.min.multiplyScalar(400)
          geometry.boundingBox.max.multiplyScalar(400)
        }

        if (geometry.boundingSphere) {
          geometry.boundingSphere.radius *= 400
        }
      }
    })

    this.animationMixer = new AnimationMixer(this.instance)
    model.animations.forEach(a => this.animationsMap!.set(a.name, this.animationMixer!.clipAction(a)))

    Game.instance().scene.add(this.instance)
  }

  destroy(): void {
    super.destroy()

    this.instance?.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose()
      }
    })

    if (this.instance)
      Game.instance().scene.remove(this.instance)
  }

  update(delta: number): void {
    this.animationMixer?.update(delta)

    super.update(delta)
  }

  /**
   * Blend between different animation states for this Entity3D
   *
   * https://threejs.org/examples/?q=skin#webgl_animation_skinning_morph
   */
  fadeToAction(action: AnimationAction, duration: number) {
    this.previousAction = this.activeAction
    this.activeAction = action

    if (this.previousAction !== this.activeAction) {
      this.previousAction?.fadeOut(duration)
    }

    action
      .reset()
      .setEffectiveTimeScale(1)
      .setEffectiveWeight(1)
      .fadeIn(duration)
      .play()
  }
}
