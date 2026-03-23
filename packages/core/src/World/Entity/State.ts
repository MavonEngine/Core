import type Actor from '../Actor'
import type GameObject from '../GameObject'

export default abstract class EntityState {
  entity: Actor

  constructor(entity: Actor) {
    this.entity = entity

    this.enter()
  }

  /**
   * Start playing any sounds or animations
   */
  public enter(): void {
  }

  /**
   * Stop playing any sounds or animations
   */
  public suspend(): void {
  }

  /**
   * Remove any buffered sounds / particles / entities etc
   */
  private destroy(): void {
  }

  public leave(): void {
    this.suspend()
    this.destroy()
    this.entity.state.pop()

    /**
     * Enter the previous state again
     */
    if (this.entity.state.length) {
      this.entity.state[this.entity.state.length - 1].enter()
    }
  }

  abstract update(delta: number, entity?: GameObject): EntityState | void
}
