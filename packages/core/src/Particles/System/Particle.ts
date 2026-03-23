import type { Vector3 } from 'three'
import GameObject from '../../World/GameObject'

export default class Particle extends GameObject {
  decay: number
  position: Vector3
  age = 0
  startAlpha = 1

  constructor(decay: number, position: Vector3) {
    super()

    this.decay = decay
    this.position = position
  }

  update(delta: number): void {
    this.age += delta
  }

  get alpha(): number {
    return Math.max(this.startAlpha * (1 - this.age / this.decay), 0)
  }
}
