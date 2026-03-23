export interface Damageable {
  health: number
  maxHealth: number
  isDead(): boolean
  takeDamage(amount: number): void
  heal(amount: number): void
}
