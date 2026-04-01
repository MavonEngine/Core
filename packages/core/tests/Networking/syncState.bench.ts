import type EntityState from '../../src/World/Entity/State'
import { bench, describe } from 'vitest'
import NetworkedActor from '../../src/Networking/NetworkedActor'
import NetworkedEntityState from '../../src/Networking/NetworkedEntityState'
import { syncStateStack } from '../../src/Networking/syncState'

class TestActor extends NetworkedActor {
  $typeName = 'testActor'
  updateFromNetwork = (_data: object) => {}
  update(_delta: number): void {}
}

class StateA extends NetworkedEntityState {
  readonly stateName = 'stateA'
  update(_delta: number): EntityState | void {}
}

class StateB extends NetworkedEntityState {
  readonly stateName = 'stateB'
  update(_delta: number): EntityState | void {}
}

const factories = {
  stateA: (entity: TestActor) => new StateA(entity),
  stateB: (entity: TestActor) => new StateB(entity),
}

describe('syncStateStack', () => {
  bench('no-op (states already match)', () => {
    const actor = new TestActor()
    actor.state.push(new StateA(actor))
    syncStateStack(actor, [{ stateName: 'stateA' }], factories)
  })

  bench('full replacement (stateB → stateA)', () => {
    const actor = new TestActor()
    actor.state.push(new StateB(actor))
    syncStateStack(actor, [{ stateName: 'stateA' }], factories)
  })

  bench('add to stack (1 → 2 states)', () => {
    const actor = new TestActor()
    actor.state.push(new StateA(actor))
    syncStateStack(actor, [{ stateName: 'stateA' }, { stateName: 'stateB' }], factories)
  })

  bench('remove from stack (2 → 1 states)', () => {
    const actor = new TestActor()
    actor.state.push(new StateA(actor))
    actor.state.push(new StateB(actor))
    syncStateStack(actor, [{ stateName: 'stateA' }], factories)
  })

  bench('clear all states (2 → 0)', () => {
    const actor = new TestActor()
    actor.state.push(new StateA(actor))
    actor.state.push(new StateB(actor))
    syncStateStack(actor, [], factories)
  })
})
