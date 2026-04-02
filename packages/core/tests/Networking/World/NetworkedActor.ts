import { describe, expect, it } from 'vitest'
import NetworkedActor from '../../../src/Networking/NetworkedActor'

class DummyActor extends NetworkedActor {
  updateFromNetwork!: (data: object) => void
  $typeName = 'dummActor'

  update(_delta: number): void {
    throw new Error('Method not implemented.')
  }
}

describe('actor', () => {
  it('sets needsSync when state hash changes', () => {
    const actor = new DummyActor()
    actor.markSyncd()
    const initialHash = actor.stateHash

    actor.position.set(1, 0, 0)
    actor.update(0)

    expect(actor.needsSync).toBe(true)
    expect(actor.stateHash).not.toBe(initialHash)
  })

  it('markSyncd resets flag', () => {
    const actor = new DummyActor()
    actor.needsSync = true
    actor.markSyncd()
    expect(actor.needsSync).toBe(false)
  })
})
