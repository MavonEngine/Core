import { float, mod, uniform, vec3, vec4 } from 'three/tsl'
import { PointsNodeMaterial } from 'three/webgpu'
import Game from '../../Game'
import Emitter from '../System/Emitter'
import ParticleEffect from '../System/ParticleEffect'
import { registerParticle } from '../System/ParticlePreviewRegistry'

export class RainEmitter extends Emitter {
  static preview = {
    cameraPosition: [0, 5, 10] as [number, number, number],
    cameraTarget: [0, 0, 0] as [number, number, number],
    create: () => new RainEmitter(),
  }

  readonly uniforms = {
    uTime: uniform(0),
  }

  constructor() {
    super(Game.instance().camera.worldPosition, new PointsNodeMaterial({
      transparent: true,
      sizeAttenuation: false,
    }), 1000, 20)
    // The drops are placed around the world's origin
    this.mesh.position.set(0, 0, 0)

    for (let i = 0; i < this.maxParticles; i++) {
      const i3 = i * 3
      this.positions[i3] = (Math.random() - 0.5) * 20
      this.positions[i3 + 1] = (Math.random() - 0.5) * 20
      this.positions[i3 + 2] = (Math.random() - 0.5) * 20
    }

    // Falling, and back to the top once below the 20 unit box
    const start = this.positionNode
    const y = mod(start.y.sub(this.uniforms.uTime.mul(7)).add(20), 20).sub(10)
    this.material.positionNode = vec3(start.x, y, start.z)
    this.material.sizeNode = float(2)
    this.material.colorNode = vec4(1, 1, 1, 0.8)
  }

  update(delta: number): void {
    this.uniforms.uTime.value += delta
  }
}

registerParticle('Rain', {
  preview: RainEmitter.preview,
  spawn: () => new Rain(),
})

export default class Rain extends ParticleEffect {
  rainEmitter: Emitter

  constructor() {
    super()

    this.rainEmitter = new RainEmitter()
    this.emitters.push(this.rainEmitter)
  }
}
