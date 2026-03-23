import type ParticleEffect from './ParticleEffect'
import Game from '../../Game'
import GameObject from '../../World/GameObject'

export default class ParticleSystem extends GameObject {
  effects: ParticleEffect[] = []

  stats = {
    particles: 0,
  }

  constructor() {
    super()

    const particlePane = Game.instance().debug.ui?.addFolder({
      title: 'Particles',
    })

    if (particlePane) {
      particlePane.addBinding(this.stats, 'particles', { label: 'Particles', readonly: true })
    }
  }

  addEffect(effect: ParticleEffect) {
    this.effects.push(effect)
  }

  update(delta: number): void {
    this.stats.particles = 0

    this.effects.forEach((effect) => {
      effect.update(delta)

      if (Game.instance().debug.active)
        effect.emitters.forEach(emitter => this.stats.particles += emitter.particles.length)
    })
  }
}
