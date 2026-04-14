import type LivingEntity from './Entity/interface/LivingEntity'
import Actor from './Actor'

export default abstract class LivingActor extends Actor implements LivingEntity {
  abstract health: number
  abstract maxHealth: number

  abstract isDead(): boolean
  abstract takeDamage(amount: number): void
  abstract heal(amount: number): void

  public serialize() {
    return {
      ...super.serialize(),
      health: this.health,
    }
  }
}
