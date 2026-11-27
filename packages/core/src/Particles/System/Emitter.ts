import type { Vector3 } from 'three'
import type { Node, PointsNodeMaterial } from 'three/webgpu'
import type Particle from './Particle'
import { instancedBufferAttribute } from 'three/tsl'
import { BufferGeometry, InstancedBufferAttribute, Sprite } from 'three/webgpu'
import Game from '../../Game'
import GameObject from '../../World/GameObject'

export interface EmitterPreviewConfig {
  cameraPosition: [number, number, number]
  cameraTarget: [number, number, number]
  create(): InstanceType<typeof Emitter> | null
}

/**
 * Draws its particles as camera facing quads, one instance per particle (WebGPU only draws points 1px wide).
 * Fill `positions`, `scales` and `alphas` and flag them in `update()`; the material reads them through
 * `positionNode`, `scaleNode` and `alphaNode`. The material's `positionNode` is set to the particle's position unless
 * it has one already.
 */
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

  material: PointsNodeMaterial
  /** Holds the particle attributes as `position`, `aScale` and `aAlpha` */
  geometry: BufferGeometry
  mesh: Sprite

  positions: Float32Array<ArrayBuffer>
  scales: Float32Array<ArrayBuffer>
  alphas: Float32Array<ArrayBuffer>

  /** Each particle's position, relative to the emitter */
  readonly positionNode: Node<'vec3'>
  readonly scaleNode: Node<'float'>
  readonly alphaNode: Node<'float'>

  maxLifeTimeParticle: number
  maxParticles!: number

  particles: Particle[] = []

  constructor(position: Vector3, material: PointsNodeMaterial, maxParticles: number, maxLifeTimeParticle: number) {
    super()

    this.maxParticles = maxParticles
    this.maxLifeTimeParticle = maxLifeTimeParticle

    this.material = material

    this.geometry = new BufferGeometry()
    this.positions = new Float32Array(this.maxParticles * 3)
    this.scales = new Float32Array(this.maxParticles)
    this.alphas = new Float32Array(this.maxParticles)

    const positionAttribute = new InstancedBufferAttribute(this.positions, 3)
    const scaleAttribute = new InstancedBufferAttribute(this.scales, 1)
    const alphaAttribute = new InstancedBufferAttribute(this.alphas, 1)
    this.geometry.setAttribute('position', positionAttribute)
    this.geometry.setAttribute('aScale', scaleAttribute)
    this.geometry.setAttribute('aAlpha', alphaAttribute)

    this.positionNode = instancedBufferAttribute(positionAttribute, 'vec3') as unknown as Node<'vec3'>
    this.scaleNode = instancedBufferAttribute(scaleAttribute, 'float') as unknown as Node<'float'>
    this.alphaNode = instancedBufferAttribute(alphaAttribute, 'float') as unknown as Node<'float'>
    material.positionNode ??= this.positionNode

    this.mesh = new Sprite(material)
    this.mesh.count = maxParticles
    // The particles spread out from the emitter, where a sprite's bounds would put them all
    this.mesh.frustumCulled = false
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

    if (!this.continoues && !this.particles.some(particle => particle.age < particle.decay)) {
      this.destroy()
    }
  }
}
