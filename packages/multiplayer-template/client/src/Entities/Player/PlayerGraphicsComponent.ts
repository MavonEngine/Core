import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import Game from '@mavonengine/core/Game'
import Entity3D from '@mavonengine/core/World/Entity3D'
import { Vector3 } from 'three'

/** The player's model's feet sit this far below the player's position, the center of its collider */
const PLAYER_FOOT_OFFSET = 0.8
/**
 * How quickly the model catches up with the character's position, per second. The position only changes with each
 * tick and network update, 30 times a second and unevenly; following it smoothly every rendered frame keeps the model
 * from stepping, which shows as a double image in a VR headset. Higher follows tighter, with less smoothing.
 */
const FOLLOW_RATE = 12
/** Further than this from the character and the model jumps there instead, e.g. after a respawn */
const SNAP_DISTANCE = 3

/** What the model follows: its position and rotation, which the network moves */
export interface ModelSubject {
  position: Vector3
  rotation: Vector3
}

export interface CharacterModelOptions {
  /** How far below the subject's position its feet are. Default the player's, whose position is its middle */
  footOffset?: number
  /** Once the model has loaded and its animations can play */
  onReady?(): void
}

/**
 * The character model (the `character` resource), following a subject smoothly: a player, or an NPC that uses the
 * same model
 */
export default class PlayerGraphicsComponent extends Entity3D {
  private readonly subject: ModelSubject
  private readonly footOffset: number
  private readonly onReady?: () => void
  private placed = false
  private readonly target = new Vector3()

  private readonly onFrame = (delta: number) => this.follow(delta)

  constructor(subject: ModelSubject, options: CharacterModelOptions = {}) {
    super()
    this.subject = subject
    this.footOffset = options.footOffset ?? PLAYER_FOOT_OFFSET
    this.onReady = options.onReady
    Game.instance().on('beforeRender', this.onFrame)
  }

  init() {
    const onLoaded = () => {
      this.initModel(Game.instance().resources.items.character as GLTF)
      this.onReady?.()
    }

    if (Game.instance().resources.loaded) {
      onLoaded()
    }
    else {
      Game.instance().resources.on('loaded', onLoaded)
    }
  }

  /** Where the model's feet are drawn, which trails the character's position a little to move smoothly */
  get renderedPosition(): Vector3 | undefined {
    return this.instance?.position
  }

  private follow(delta: number) {
    if (!this.instance)
      return

    this.target.set(this.subject.position.x, this.subject.position.y - this.footOffset, this.subject.position.z)
    const targetYaw = this.subject.rotation.y + Math.PI

    if (!this.placed || this.instance.position.distanceTo(this.target) > SNAP_DISTANCE) {
      this.instance.position.copy(this.target)
      this.instance.rotation.y = targetYaw
      this.placed = true
      return
    }

    const t = 1 - Math.exp(-FOLLOW_RATE * delta)
    this.instance.position.lerp(this.target, t)
    // Shortest way round, so turning past +-180 degrees doesn't spin the long way
    const diff = Math.atan2(Math.sin(targetYaw - this.instance.rotation.y), Math.cos(targetYaw - this.instance.rotation.y))
    this.instance.rotation.y += diff * t
  }

  destroy(): void {
    Game.instance().off('beforeRender', this.onFrame)
    super.destroy()
  }
}
