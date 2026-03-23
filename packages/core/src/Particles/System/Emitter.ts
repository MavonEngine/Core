import type { Material, Object3D, Vector3 } from 'three'
import type Particle from './Particle'
import { BufferAttribute, BufferGeometry, Points } from 'three'
import Game from '../../Game'
import GameObject from '../../World/GameObject'

export interface EmitterPreviewConfig {
  cameraPosition: [number, number, number]
  cameraTarget: [number, number, number]
  create(): InstanceType<typeof Emitter> | null
}

export default abstract class Emitter extends GameObject {
  static preview: EmitterPreviewConfig | null = null
  /**
   * If this is not a continous emitter it automatically destroys
   * itself when all particles have decayed
   */
  continoues = true

  /**
   * Mark for garbage collection
   */
  garbageCollect = false

  material: Material
  geometry: BufferGeometry
  mesh: Object3D

  positions: Float32Array<ArrayBuffer>
  scales: Float32Array<ArrayBuffer>
  alphas: Float32Array<ArrayBuffer>

  maxLifeTimeParticle: number
  maxParticles!: number

  particles: Particle[] = []

  constructor(position: Vector3, material: Material, maxParticles: number, maxLifeTimeParticle: number) {
    super()

    this.maxParticles = maxParticles
    this.maxLifeTimeParticle = maxLifeTimeParticle

    this.material = material

    this.geometry = new BufferGeometry()
    this.positions = new Float32Array(this.maxParticles * 3)
    this.scales = new Float32Array(this.maxParticles)
    this.alphas = new Float32Array(this.maxParticles)

    this.geometry.setAttribute('position', new BufferAttribute(this.positions, 3))
    this.geometry.setAttribute('aScale', new BufferAttribute(this.scales, 1))
    this.geometry.setAttribute('aAlpha', new BufferAttribute(this.alphas, 1))

    this.mesh = new Points(this.geometry, this.material)
    this.mesh.position.set(position.x, position.y, position.z)

    Game.instance().scene.add(this.mesh)
  }

  /**
   * Remove everything from the scene
   */
  destroy() {
    super.destroy()

    Game.instance().scene.remove(this.mesh)
    this.geometry.dispose()
    this.material.dispose()
  }

  update(_delta: number): void {
    // Mark attribute as needing update
    this.geometry.attributes.aScale.needsUpdate = true
    this.geometry.attributes.position.needsUpdate = true

    if (!this.continoues && this.particles.filter(particle => particle.age < particle.decay).length === 0) {
      this.destroy()
    }
  }
}
