import { ClientCommand } from '@template/server/src/Commands'
import type { CL_MOVE } from '@template/server/src/Commands/Client'
import Game from '@mavonengine/core/Game'
import GameObject from '@mavonengine/core/World/GameObject'
import { Vector3 } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import NetworkManager from './NetworkManager'
import type Character from './Entities/Player'

/**
 * Handles local player input and camera.
 * Sends CL_MOVE to the server only when keys change.
 * Receives server position corrections and lerps to them.
 */
export default class PlayerController extends GameObject {
  player: Character
  orbitControls: OrbitControls
  lerpTo?: Vector3 | null
  private lastMove?: object

  constructor(player: Character) {
    super()
    this.player = player

    this.orbitControls = new OrbitControls(
      Game.instance().camera.instance,
      Game.instance().canvas,
    )
    this.orbitControls.enableDamping = true
    this.orbitControls.maxDistance = 25
    this.orbitControls.minDistance = 5
    this.orbitControls.minPolarAngle = (Math.PI / 180) * 40
    this.orbitControls.maxPolarAngle = (Math.PI / 180) * 75
    this.orbitControls.target.copy(player.position)
  }

  update(delta: number): void {
    // Lerp toward server-corrected position
    if (this.lerpTo && this.lerpTo.distanceTo(this.player.position) > 0.01) {
      this.player.position.lerp(this.lerpTo, 0.2)
    }

    // Smoothly follow player
    const desiredTarget = new Vector3().copy(this.player.position).add(new Vector3(0, 0.5, 0))
    this.orbitControls.target.lerp(desiredTarget, 0.1)
    this.orbitControls.update(delta)

    this.player.update(delta)

    // Don't steal keystrokes while the player is typing in the chat input
    if (document.activeElement?.tagName === 'INPUT') {
      return
    }

    // Send movement input to server (only on change)
    const keys = Array.from(Game.instance().input.keysPressed.keys())
    const isMoving = keys.some(k => ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(k))

    // While moving, smoothly rotate toward camera azimuth via shortest arc
    if (isMoving) {
      const targetYaw = this.orbitControls.getAzimuthalAngle()
      let diff = targetYaw - this.player.rotation.y
      // Wrap diff to [-PI, PI] so we always take the shortest arc
      diff = ((diff + Math.PI) % (Math.PI * 2)) - Math.PI
      this.player.rotation.y += diff * Math.min(1, 10 * delta)
    }

    const move: CL_MOVE = {
      type: ClientCommand.CL_MOVE,
      sequenceId: 0,
      keys,
      yaw: this.player.rotation.y,
    }

    if (JSON.stringify(this.lastMove) !== JSON.stringify(move)) {
      this.lastMove = move
      NetworkManager.getInstance().socket.emit('command', move)
    }
  }

  updateFromNetwork(entityData: any) {
    const serverPosition = new Vector3(
      entityData.position.x,
      entityData.position.y,
      entityData.position.z,
    )

    if (serverPosition.distanceTo(this.player.position) > 0.2) {
      this.lerpTo = serverPosition
    }

    this.player.updateFromNetwork(entityData)
  }

  destroy(): void {
    this.orbitControls.dispose()
    super.destroy()
  }
}
