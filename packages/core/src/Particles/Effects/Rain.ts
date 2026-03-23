import { BufferAttribute, BufferGeometry, Points, ShaderMaterial } from 'three'
import Game from '../../Game'
import RainFragmentShader from '../Shaders/Rain/Fragment.glsl'
import RainVertextShader from '../Shaders/Rain/Vertex.glsl'
import Emitter from '../System/Emitter'
import ParticleEffect from '../System/ParticleEffect'
import { registerParticle } from '../System/ParticlePreviewRegistry'

export class RainEmitter extends Emitter {
  static preview = {
    cameraPosition: [0, 5, 10] as [number, number, number],
    cameraTarget: [0, 0, 0] as [number, number, number],
    create: () => new RainEmitter(),
  }

  declare geometry: BufferGeometry
  declare mesh: Points
  declare material: ShaderMaterial

  constructor() {
    super(Game.instance().camera.instance.position, new ShaderMaterial({
      transparent: true,
      vertexShader: RainVertextShader,
      fragmentShader: RainFragmentShader,
      uniforms: {
        uTime: { value: 0 },
        uCameraPosition: { value: Game.instance().camera.instance.position },
      },
    }), 1000, 20)

    this.geometry = new BufferGeometry()
    this.mesh = new Points(this.geometry, this.material)

    const positions = new Float32Array(this.maxParticles * 3)

    for (let i = 0; i < this.maxParticles; i++) {
      const i3 = i * 3
      positions[i3] = (Math.random() - 0.5) * 20
      positions[i3 + 1] = (Math.random() - 0.5) * 20
      positions[i3 + 2] = (Math.random() - 0.5) * 20
    }

    this.geometry.setAttribute('position', new BufferAttribute(positions, 3))

    Game.instance().scene.add(this.mesh)
  }

  update(delta: number): void {
    this.material.uniforms.uTime.value += delta
    this.material.uniforms.uCameraPosition.value = Game.instance().camera.instance.position
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
