import type { KinematicCharacterController, World } from '@dimforge/rapier3d-compat'
import type winston from 'winston'
import type Logger from './Utils/Logger'
import type GameObjectInterface from './World/GameObjectInterface'
import { Clock, Raycaster, Scene } from 'three'
import EventEmitter from './Utils/EventEmitter'
import { version as ENGINE_VERSION } from './version'

import BaseWorld from './World/BaseWorld'

export { ENGINE_VERSION }

let instance: BaseGame

/**
 * This is the headless representation of the game.
 * This is what the game server uses to represent the game state.
 *
 * Do not add anything related to audio or rendering here
 */
export default class BaseGame extends EventEmitter implements GameObjectInterface {
  readonly clock: Clock

  logger?: winston.Logger | Logger | null

  physicsWorld?: World
  characterController?: KinematicCharacterController

  scene: Scene
  rayCaster: Raycaster
  world: BaseWorld

  protected updateCallbacks: Set<(delta: number) => void> = new Set()

  tickRate = 30
  lastTickTime = 0

  constructor(logger?: winston.Logger | Logger | null, physicsWorld?: World) {
    super()

    // eslint-disable-next-line ts/no-this-alias
    instance = this

    this.logger = logger
    this.logger?.info([
      '',
      '',
      '┌─────────────────────────────────────────┐',
      '│                                         │',
      '│              MavonEngine                │',
      '│                                         │',
      `│  Version:  ${ENGINE_VERSION.padEnd(28)} │`,
      // eslint-disable-next-line node/prefer-global/process
      `│  Mode:     ${(process.env.NODE_ENV ?? 'development').padEnd(28)} │`,
      '│                                         │',
      '│  https://github.com/MavonEngine/core    │',
      '│  https://mavonengine.com                │',
      '│                                         │',
      '└─────────────────────────────────────────┘',
      '',
    ].join('\n'))

    this.physicsWorld = physicsWorld

    if (this.physicsWorld) {
      this.characterController = this.physicsWorld.createCharacterController(0.01)
      this.characterController.setApplyImpulsesToDynamicBodies(true)
      this.characterController.enableSnapToGround(30)

      // Don’t allow climbing slopes larger than 45 degrees.
      this.characterController.setMaxSlopeClimbAngle(45 * Math.PI / 180)

      // Automatically slide down on slopes bigger than 30 degrees.
      this.characterController.setMinSlopeSlideAngle(30 * Math.PI / 180)
    }

    this.clock = new Clock()
    this.clock.start()

    this.scene = new Scene()
    this.rayCaster = new Raycaster()

    this.world = new BaseWorld()

    setInterval(() => {
      this.tick()
    }, 1000 / this.tickRate)
  }

  destroy(): void {
    this.logger?.emerg('Destroy called on server game instance')
  }

  static instance() {
    return instance
  }

  tick() {
    const tickNow = performance.now()
    this.update((tickNow - this.lastTickTime) / 1000)
    this.lastTickTime = tickNow
  }

  onUpdate(callback: (delta: number) => void): void {
    this.updateCallbacks.add(callback)
  }

  unregisterOnUpdate(callback: (delta: number) => void): void {
    this.updateCallbacks.delete(callback)
  }

  update(delta: number): void {
    if (this.physicsWorld) {
      this.physicsWorld.timestep = delta
      this.physicsWorld.step()
    }

    this.world.update(delta)

    this.updateCallbacks.forEach(callbackFn => callbackFn(delta))
  }

  isDevMode() {
    // eslint-disable-next-line node/prefer-global/process
    return process.env.NODE_ENV !== 'production'
  }

  isProductionMode() {
    // eslint-disable-next-line node/prefer-global/process
    return process.env.NODE_ENV === 'production'
  }
}
