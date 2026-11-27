import type { BufferAttribute, Texture } from 'three'
import { texture, uniform, uv, vec2, vec4 } from 'three/tsl'
import { NormalBlending, PointsNodeMaterial, Vector3 } from 'three/webgpu'
import Game from '../../Game'
import Emitter from '../System/Emitter'
import Particle from '../System/Particle'
import ParticleEffect from '../System/ParticleEffect'
import { registerParticle } from '../System/ParticlePreviewRegistry'

export class SmokeParticle extends Particle {
  startAlpha = 0.5
  velocity!: Vector3

  constructor(lifetime: number, position: Vector3) {
    super(lifetime, position.clone())
    this.reset()
  }

  reset() {
    this.age = 0
    this.velocity = new Vector3(
      (Math.random() - 0.5) * 0.4,
      Math.random() * 0.3 + 0.4,
      (Math.random() - 0.5) * 0.2,
    )
    this.position.set(0, 0, 0)
  }

  update(delta: number): void {
    this.position.y += delta * 0.1
    this.scale = new Vector3(2 + this.age)

    // Update position
    this.position.x += this.velocity.x * delta
    this.position.y += this.velocity.y * delta
    this.position.z += this.velocity.z * delta

    super.update(delta)
  }
}

export class SmokeEmitter extends Emitter {
  static preview = {
    cameraPosition: [0, 4, 10] as [number, number, number],
    cameraTarget: [0, 3, 0] as [number, number, number],
    create: () => {
      const tex = Game.instance().resources.items.smokeTexture as Texture | undefined
      return tex
        ? new SmokeEmitter(tex, new Vector3(0, 0, 0))
        : null
    },
  }

  declare particles: SmokeParticle[]
  readonly uniforms = {
    uTime: uniform(0),
  }

  constructor(smokeTexture: Texture, position: Vector3) {
    super(position, new PointsNodeMaterial({
      transparent: true,
      blending: NormalBlending,
      depthWrite: false,
      sizeAttenuation: false,
    }), 20, 10)

    // Pixels across, like gl_PointSize was
    this.material.sizeNode = this.scaleNode.mul(40)
    // Top down, like gl_PointCoord
    const tex = texture(smokeTexture, vec2(uv().x, uv().y.oneMinus()))
    this.material.colorNode = vec4(tex.rgb, tex.a.mul(this.alphaNode))

    for (let i = 0; i < this.maxParticles; i++) {
      const particle = new SmokeParticle(Math.random() * this.maxLifeTimeParticle + 1, position)
      this.particles.push(particle)
      this.scales[i] = particle.scale.x
      this.alphas[i] = particle.alpha
    }
  }

  update(delta: number): void {
    this.uniforms.uTime.value += delta

    for (let i = 0; i < this.maxParticles; i++) {
      const particle = this.particles[i]

      if (particle.age >= particle.decay) {
        // Respawn particle
        particle.reset()
      }
      else {
        particle.update(delta)

        // Update position buffer
        this.positions[i * 3] = particle.position.x
        this.positions[i * 3 + 1] = particle.position.y
        this.positions[i * 3 + 2] = particle.position.z

        this.scales[i] = particle.scale.x
        this.alphas[i] = particle.alpha
      }
    }

    (this.geometry.getAttribute('aAlpha') as BufferAttribute).needsUpdate = true;
    (this.geometry.getAttribute('position') as BufferAttribute).needsUpdate = true
  }
}

registerParticle('Smoke', {
  preview: SmokeEmitter.preview,
  spawn: position => new Smoke(position),
})

export default class Smoke extends ParticleEffect {
  smokeEmitter?: SmokeEmitter

  constructor(position: Vector3) {
    super()

    const create = () => {
      const tex = Game.instance().resources.items.smokeTexture as Texture | undefined
      if (tex) {
        this.smokeEmitter = new SmokeEmitter(tex, position)
        this.emitters.push(this.smokeEmitter)
      }
    }

    const tex = Game.instance().resources.items.smokeTexture as Texture | undefined
    if (tex) {
      create()
    }
    else {
      Game.instance().resources.on('loaded', create)
    }
  }
}
