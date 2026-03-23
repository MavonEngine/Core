import type EntityState from '../../src/World/Entity/State'
import { describe, expect, it, vi } from 'vitest'
import NetworkedActor from '../../src/Networking/NetworkedActor'
import NetworkedEntityState from '../../src/Networking/NetworkedEntityState'
import { syncStateStack } from '../../src/Networking/syncState'

class TestActor extends NetworkedActor {
  $typeName = 'testActor'

  constructor() {
    super()

    this.updateFromNetwork = (_data) => { }
  }

  updateFromNetwork: (data: object) => void

  update(delta: number): void
  update(_delta: number): void {
    throw new Error('Method not implemented.')
  }
}

class StateOne extends NetworkedEntityState {
  stateName = 'stateOne'

  update(_delta: number): EntityState | void {
    throw new Error('Method not implemented.')
  }
}

class StateTwo extends StateOne {
  stateName = 'stateTwo'
}

describe('syncState test', () => {
  it('should add to state stack', () => {
    const testActor = new TestActor()
    const stateOne = new StateOne(testActor)

    expect(testActor.state).lengthOf(0)

    const factories = {
      stateOne: (_entity: TestActor) => stateOne,
    }

    syncStateStack(testActor, [{ stateName: 'stateOne' }], factories)

    expect(testActor.state).lengthOf(1)
  })

  it('calls leave when syncing missing item', () => {
    const testActor = new TestActor()
    const stateOne = new StateOne(testActor)
    testActor.state.push(stateOne)

    const leave = vi.spyOn(stateOne as any, 'leave')
    const destroy = vi.spyOn(stateOne as any, 'destroy')

    const factories = {}

    syncStateStack(testActor, [], factories)

    expect(destroy).toHaveBeenCalledOnce()
    expect(leave).toHaveBeenCalledOnce()
  })

  it('calls suspend / enter on old state when new state is added / removed', () => {
    const testActor = new TestActor()
    const stateOne = new StateOne(testActor)
    const stateTwo = new StateTwo(testActor)
    testActor.state.push(stateOne)

    const factories = {
      stateOne: (_entity: TestActor) => stateOne,
      stateTwo: (_entity: TestActor) => stateTwo,
    }

    const stateOneSuspend = vi.spyOn(stateOne as any, 'suspend')
    const stateOneEnter = vi.spyOn(stateOne as any, 'enter')

    syncStateStack(testActor, [
      { stateName: 'stateOne' },
      { stateName: 'stateTwo' },
    ], factories)

    expect(stateOneSuspend).toHaveBeenCalledOnce()

    syncStateStack(testActor, [
      { stateName: 'stateOne' },
    ], factories)

    expect(stateOneEnter).toHaveBeenCalledOnce()
  })

  it('replaces state when server has different state at same index (aimingState -> shootState bug)', () => {
    /**
     * This reproduces the bug where:
     * - Server: player shoots, aimingState.leave() is called, server has [shootState]
     * - Client: has [aimingState]
     * - Sync should result in client having [shootState], not keeping [aimingState]
     */
    const testActor = new TestActor()
    const aimingState = new StateOne(testActor)
    aimingState.stateName = 'aimingState'

    testActor.state.push(aimingState)

    let shootStateCreationCount = 0
    const factories = {
      aimingState: (_entity: TestActor) => aimingState,
      shootState: (_entity: TestActor) => {
        shootStateCreationCount++
        const shootState = new StateTwo(_entity)
        shootState.stateName = 'shootState'
        return shootState
      },
    }

    // Server sends [shootState] - aimingState was left/popped on server
    syncStateStack(testActor, [{ stateName: 'shootState' }], factories)

    // Client should now have [shootState], not [aimingState]
    expect(testActor.state).lengthOf(1)
    expect(testActor.state[0].stateName).toBe('shootState')
    expect(shootStateCreationCount).toBe(1)

    // Calling sync again should NOT create another shootState
    syncStateStack(testActor, [{ stateName: 'shootState' }], factories)
    expect(shootStateCreationCount).toBe(1)
  })

  it('does not keep aimingState on stack when transitioning to shootState', () => {
    /**
     * When transitioning from aimingState to shootState:
     * - The aimingState should NOT remain on the stack
     * - Only shootState should be on the stack
     */
    const testActor = new TestActor()
    const aimingState = new StateOne(testActor)
    aimingState.stateName = 'aimingState'

    testActor.state.push(aimingState)

    const leaveSpy = vi.spyOn(aimingState, 'leave')

    const factories = {
      shootState: (_entity: TestActor) => {
        const shootState = new StateTwo(_entity)
        shootState.stateName = 'shootState'
        return shootState
      },
    }

    // Server has [shootState] after aimingState.leave() was called
    syncStateStack(testActor, [{ stateName: 'shootState' }], factories)

    // aimingState should have been removed (leave called)
    expect(leaveSpy).toHaveBeenCalled()

    // Stack should only contain shootState
    expect(testActor.state).lengthOf(1)
    expect(testActor.state[0].stateName).toBe('shootState')

    // aimingState should not be in the stack at all
    const hasAimingState = testActor.state.some(s => s.stateName === 'aimingState')
    expect(hasAimingState).toBe(false)
  })
})
