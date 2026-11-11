import { describe, expect, it, vi } from 'vitest'
import NetworkedLivingActor from '../../src/Networking/NetworkedLivingActor'

class TestLivingActor extends NetworkedLivingActor {
  $typeName = 'testLivingActor'
  health = 100
  maxHealth = 100
  name = 'Player'

  takeDamage(_amount: number): void {}
  heal(_amount: number): void {}

  serialize() {
    return { ...super.serialize(), name: this.name }
  }
}

describe('networkedLivingActor', () => {
  it('needs a sync after something it serializes changed', () => {
    const actor = new TestLivingActor()
    actor.update(0)
    actor.markSyncd()

    actor.update(0)
    expect(actor.needsSync).toBe(false)

    actor.position.set(1, 0, 0)
    actor.update(0)
    expect(actor.needsSync).toBe(true)

    actor.markSyncd()
    actor.name = 'Renamed'
    actor.update(0)
    expect(actor.needsSync).toBe(true)
  })

  it('serializes itself once per update to tell whether it changed', () => {
    const actor = new TestLivingActor()
    const serialize = vi.spyOn(actor, 'serialize')

    actor.position.set(1, 0, 0)
    actor.update(0)

    expect(serialize).toHaveBeenCalledTimes(1)
  })

  it('takes fields with characters outside Latin-1', () => {
    const actor = new TestLivingActor()
    actor.name = '日本語 🎮'

    expect(() => actor.update(0)).not.toThrow()
    expect(actor.needsSync).toBe(true)
  })
})
