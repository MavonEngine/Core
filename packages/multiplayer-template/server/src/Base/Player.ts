import RAPIER from '@dimforge/rapier3d-compat'
import BaseGame from '@mavonengine/core/BaseGame'
import BasePlayer from '@mavonengine/core/Networking/Entities/Player'
import NetworkedEntityFactory from '@mavonengine/core/Networking/NetworkedEntityFactory'
import { Vector3 } from 'three'

/**
 * Base player class shared between client and server.
 *
 * The server extends this with Server/Entities/Player.ts (adds initial state push).
 * The client extends this with Entities/Player.ts (adds Three.js mesh rendering).
 */
export default class Player extends BasePlayer {
  health = 100
  maxHealth = 100
  name?: string

  /**
   * Current keys held down - updated each tick from client input or from network.
   */
  keysPressed: Set<string> = new Set()

  characterCollider?: RAPIER.Collider
  rigidBody?: RAPIER.RigidBody

  velocityY = 0
  horizontalIntent = new Vector3()

  constructor(id?: string, spawn = new Vector3()) {
    super(id)
    this.position.copy(spawn)

    const physicsWorld = BaseGame.instance().physicsWorld
    if (physicsWorld) {
      const characterDesc = RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        spawn.x,
        spawn.y + 1,
        spawn.z,
      )
      this.rigidBody = physicsWorld.createRigidBody(characterDesc)

      const characterColliderDesc = RAPIER.ColliderDesc.capsule(0.4, 0.4)
      this.characterCollider = physicsWorld.createCollider(characterColliderDesc, this.rigidBody)
    }
  }

  isDead(): boolean {
    return this.health <= 0
  }

  takeDamage(amount: number): void {
    this.health -= amount
  }

  heal(amount: number): void {
    this.health = Math.min(this.maxHealth, this.health + amount)
  }

  update(delta: number): void {
    this.horizontalIntent.set(0, 0, 0)
    super.update(delta) // states run here and may write to horizontalIntent

    if (this.isDead() || !this.characterCollider || !this.rigidBody)
      return

    const cc = BaseGame.instance().characterController
    if (cc) {
      this.velocityY += -9.83 * delta
      const moveIntent = this.horizontalIntent.clone()
      moveIntent.y += this.velocityY * delta

      cc.computeColliderMovement(this.characterCollider, moveIntent)
      const deltaMove = cc.computedMovement()

      const pos = this.rigidBody.translation()
      this.rigidBody.setNextKinematicTranslation({
        x: pos.x + deltaMove.x,
        y: pos.y + deltaMove.y,
        z: pos.z + deltaMove.z,
      })

      // Reset vertical velocity when floor stops downward movement
      if (deltaMove.y > moveIntent.y) {
        this.velocityY = 0
      }
    }

    this.position.set(
      this.characterCollider.translation().x,
      this.characterCollider.translation().y,
      this.characterCollider.translation().z,
    )
  }

  destroy(): void {
    if (this.characterCollider) {
      BaseGame.instance().physicsWorld?.removeCollider(this.characterCollider, false)
    }
    super.destroy()
  }

  public serialize(): object {
    return {
      ...super.serialize(),
      name: this.name,
    }
  }

  toJSON() {
    return this.serialize()
  }
}
