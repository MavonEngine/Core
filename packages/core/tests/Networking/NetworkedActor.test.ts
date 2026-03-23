import type EntityState from '../../src/World/Entity/State'
import { describe, expect, it, vi } from 'vitest'
import NetworkedActor from '../../src/Networking/NetworkedActor'
import NetworkedEntityState from '../../src/Networking/NetworkedEntityState'

class TestActor extends NetworkedActor {
  $typeName = 'testActor'
  updateFromNetwork = (_data: object) => {}
  update(_delta: number): void {}
}

class TestState extends NetworkedEntityState {
  stateName = 'testState'
  update(_delta: number): EntityState | void {}
}

describe('networkedActor', () => {
  it('initializes with empty state array', () => {
    const actor = new TestActor()
    expect(actor.state).toHaveLength(0)
  })

  it('message getter includes $typeName', () => {
    const actor = new TestActor()
    expect(actor.message).toContain('testActor')
  })

  it('previousStateHash defaults to empty string', () => {
    const actor = new TestActor()
    expect(actor.previousStateHash).toBe('')
  })

  it('needsSync defaults to true', () => {
    const actor = new TestActor()
    expect(actor.needsSync).toBe(true)
  })

  it('markSyncd() sets needsSync to false', () => {
    const actor = new TestActor()
    actor.markSyncd()
    expect(actor.needsSync).toBe(false)
  })

  it('needsSync resets to true after re-construction', () => {
    const actor = new TestActor()
    actor.markSyncd()
    expect(actor.needsSync).toBe(false)
    const actor2 = new TestActor()
    expect(actor2.needsSync).toBe(true)
  })
})

describe('networkedEntityState', () => {
  it('serialize() returns an object with stateName', () => {
    const actor = new TestActor()
    const state = new TestState(actor)
    expect(state.serialize()).toEqual({ stateName: 'testState' })
  })

  it('toJSON() returns the same value as serialize()', () => {
    const actor = new TestActor()
    const state = new TestState(actor)
    expect(state.toJSON()).toEqual(state.serialize())
  })

  it('calls enter() on construction', () => {
    const actor = new TestActor()
    const enterSpy = vi.spyOn(TestState.prototype, 'enter')
    const _state = new TestState(actor)
    expect(enterSpy).toHaveBeenCalledOnce()
    enterSpy.mockRestore()
  })

  it('leave() removes state from the actor state stack', () => {
    const actor = new TestActor()
    const state = new TestState(actor)
    actor.state.push(state)
    expect(actor.state).toHaveLength(1)
    state.leave()
    expect(actor.state).toHaveLength(0)
  })

  it('leave() calls suspend() before removing from stack', () => {
    const actor = new TestActor()
    const state = new TestState(actor)
    actor.state.push(state)
    const suspendSpy = vi.spyOn(state, 'suspend')
    state.leave()
    expect(suspendSpy).toHaveBeenCalledOnce()
  })

  it('leave() calls enter() on the previous state', () => {
    const actor = new TestActor()
    const stateOne = new TestState(actor)
    const stateTwo = new TestState(actor)
    actor.state.push(stateOne)
    actor.state.push(stateTwo)

    const enterSpy = vi.spyOn(stateOne, 'enter')
    stateTwo.leave()
    expect(enterSpy).toHaveBeenCalledOnce()
  })
})
