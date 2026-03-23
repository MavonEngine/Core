import { describe, expect, it, vi } from 'vitest'
import Actor from '../../src/World/Actor'
import EntityState from '../../src/World/Entity/State'
import StateManager from '../../src/World/StateManager'

class DummyActor extends Actor {
  update() {}
}

class DummyState extends EntityState {
  update = vi.fn()
}

describe('stateManager', () => {
  it('pushes new state returned from update', () => {
    const actor = new DummyActor()
    const manager = new StateManager()
    const state1 = new DummyState(actor)
    manager.state.push(state1)

    const state2 = new DummyState(actor)
    state1.update.mockReturnValue(state2)

    manager.update(0.1, actor)
    expect(manager.state[1]).toBe(state2)
    expect(state1.update).toHaveBeenCalledWith(0.1, actor)
  })

  it('does not push when update returns void', () => {
    const actor = new DummyActor()
    const manager = new StateManager()
    const state1 = new DummyState(actor)
    manager.state.push(state1)

    state1.update.mockReturnValue(undefined)
    manager.update(0.1, actor)

    expect(manager.state).toHaveLength(1)
  })
})
