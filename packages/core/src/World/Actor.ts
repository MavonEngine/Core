import EntityState from './Entity/State'
import GameObject from './GameObject'

/**
 * An actor can have states associated with
 */
export default abstract class Actor extends GameObject {
  /**
   * TODO rename to states and then have a get state() that will get the last entry
   */
  state: EntityState[] = []

  update(delta: number): void {
    if (this.state.length) {
      const res = this.state[this.state.length - 1].update(delta)

      if (res instanceof EntityState) {
        this.state.push(res)
      }
    }
  }

  get stateHash() {
    return btoa(JSON.stringify(this.serialize()))
  }
}
