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

  /**
   * Animations advance every rendered frame rather than every tick, so they play at the display's rate
   * (60 - 120 fps, or a VR headset's) instead of stepping at the 30 Hz tick
   */
  private readonly advanceAnimations = (delta: number) => this.animationMixer?.update(delta)

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

    if (!this.animationMixer)
      Game.instance().on('beforeRender', this.advanceAnimations)
    this.animationMixer = new AnimationMixer(this.instance)
    model.animations.forEach(a => this.animationsMap!.set(a.name, this.animationMixer!.clipAction(a)))

    Game.instance().scene.add(this.instance)
  }

  destroy(): void {
    super.destroy()
    Game.instance().off('beforeRender', this.advanceAnimations)

    this.instance?.traverse((o) => {
      if (o instanceof Mesh) {
        o.geometry.dispose()
      }
    })

    if (this.instance)
      Game.instance().scene.remove(this.instance)
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
