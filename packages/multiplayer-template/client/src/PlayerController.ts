import type { CL_MOVE } from '@template/server/Commands/Client'
import type Character from './Entities/Player'
import Game from '@mavonengine/core/Game'
import GameObject from '@mavonengine/core/World/GameObject'
import { ClientCommand } from '@template/server/Commands/Client'
import { Vector3 } from 'three'
import { OrbitControls } from 'three/addons/controls/OrbitControls.js'
import NetworkManager from './NetworkManager'
import VRControls from './VRControls'

/** How often held movement is sent again, well within the server's 400ms movement timeout */
const RESEND_MS = 200

/**
 * Handles local player input and camera.
 * Sends CL_MOVE to the server when keys change, and again every RESEND_MS while they're held.
 * Receives server position corrections and lerps to them.
 */
export default class PlayerController extends GameObject {
  player: Character
  orbitControls: OrbitControls
  /** Third person controls in a VR headset, when the game has VR */
  vrControls?: VRControls
  private lastMove?: object
  /** Whether the last update was in VR, to catch the frame a session ends */
  private wasInVR = false
  private lastSentAt = 0

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
    // VR is enabled once the browser said it can, which may be after joining
    if (!this.vrControls && Game.instance().input.xr)
      this.vrControls = new VRControls(this.player)
    const inVR = this.vrControls?.active ?? false

    // Smoothly follow player. In VR the headset and VRControls place the view instead
    if (!inVR) {
      const desiredTarget = new Vector3().copy(this.player.position).add(new Vector3(0, 0.5, 0))
      // The target stood still in VR, where the character may have walked far away: start from the character
      if (this.wasInVR)
        this.orbitControls.target.copy(desiredTarget)
      else
        this.orbitControls.target.lerp(desiredTarget, 0.1)
      this.orbitControls.update(delta)
    }
    this.wasInVR = inVR

    this.player.update(delta)

    // Don't steal keystrokes while the player is typing in the chat input
    if (document.activeElement?.tagName === 'INPUT') {
      return
    }

    // Send movement input to server, on change and while moving at least every RESEND_MS
    const vrMove = inVR
      ? this.vrControls!.move(this.player.rotation.y)
      : undefined
    const keys = vrMove?.keys ?? Array.from(Game.instance().input.keysPressed.keys())
    const isMoving = keys.some(k => ['KeyW', 'KeyA', 'KeyS', 'KeyD'].includes(k))

    // While moving, smoothly rotate toward camera azimuth (or in VR, where the stick points) via shortest arc
    if (isMoving) {
      const targetYaw = vrMove?.yaw ?? this.orbitControls.getAzimuthalAngle()
      let diff = targetYaw - this.player.rotation.y
      // Wrap diff to [-PI, PI] so we always take the shortest arc
      diff = ((diff + Math.PI) % (Math.PI * 2)) - Math.PI
      this.player.rotation.y += diff * Math.min(1, 10 * delta)
    }

    const move: CL_MOVE = {
      type: ClientCommand.CL_MOVE,
      keys,
      yaw: this.player.rotation.y,
    }

    // The server lets go of the keys when it hears nothing for a while (Player.getMovementTimeout), so held keys
    // or a held stick are sent again even when nothing changed
    const now = performance.now()
    const changed = JSON.stringify(this.lastMove) !== JSON.stringify(move)
    if (changed || (isMoving && now - this.lastSentAt >= RESEND_MS)) {
      // Spread so its a different object. Otherwise sendCommand assigns sequenceId which fails the !== check
      this.lastMove = { ...move }
      this.lastSentAt = now
      NetworkManager.getInstance().sendCommand(move)
    }
  }

  updateFromNetwork(entityData: any) {
    this.player.updateFromNetwork(entityData)

    NetworkManager.getInstance().dropCommandsAtSequenceId(this.player.lastProcessedSequenceId)
  }

  destroy(): void {
    this.orbitControls.dispose()
    this.vrControls?.destroy()
    super.destroy()
  }
}
