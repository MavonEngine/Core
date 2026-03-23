import type GameObject from './GameObject'
import EntityState from './Entity/State'

export default class StateManager {
  state: EntityState[] = []

  update(delta: number, entity: GameObject): void {
    if (this.state.length) {
      const res = this.state[this.state.length - 1].update(delta, entity)

      if (res instanceof EntityState) {
        this.state.push(res)
      }
    }
  }
}
