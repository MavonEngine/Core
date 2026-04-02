import { bench, describe } from 'vitest'
import Actor from '../../src/World/Actor'
import EntityState from '../../src/World/Entity/State'
import StateManager from '../../src/World/StateManager'

class DummyActor extends Actor {
  update() {}
}

class NoopState extends EntityState {
  update(_delta: number): EntityState | void {}
}

class TransitionState extends EntityState {
  private next: EntityState

  constructor(entity: DummyActor, next: EntityState) {
    super(entity)
    this.next = next
  }

  update(_delta: number): EntityState | void {
    return this.next
  }
}

describe('stateManager.update', () => {
  bench('empty state stack (no-op)', () => {
    const actor = new DummyActor()
    const manager = new StateManager()
    manager.update(0.016, actor)
  })

  bench('one state, returns void', () => {
    const actor = new DummyActor()
    const manager = new StateManager()
    manager.state.push(new NoopState(actor))
    manager.update(0.016, actor)
  })

  bench('one state, returns new state (triggers push)', () => {
    const actor = new DummyActor()
    const manager = new StateManager()
    const next = new NoopState(actor)
    manager.state.push(new TransitionState(actor, next))
    manager.update(0.016, actor)
  })
})
