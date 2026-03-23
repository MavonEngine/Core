import { Raycaster, Scene } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import BaseGame from './../src/BaseGame'

vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three')
  return {
    ...actual,
    Clock: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
    })),
  }
})

describe('baseGame', () => {
  let mockLogger: any
  let mockPhysicsWorld: any

  beforeEach(() => {
    mockLogger = {
      info: vi.fn(),
      emerg: vi.fn(),
    }

    const characterController = vi.fn()
    characterController.mockReturnValue({
      setApplyImpulsesToDynamicBodies: vi.fn(),
      enableSnapToGround: vi.fn(),
      setMaxSlopeClimbAngle: vi.fn(),
      setMinSlopeSlideAngle: vi.fn(),
    })

    mockPhysicsWorld = {
      step: vi.fn(),
      createCharacterController: characterController,
    }
  })

  it('should instantiate with a logger and physicsWorld', () => {
    const game = new BaseGame(mockLogger, mockPhysicsWorld)

    expect(game.logger).toBe(mockLogger)
    expect(game.physicsWorld).toBe(mockPhysicsWorld)
    expect(game.scene).toBeInstanceOf(Scene)
    expect(game.rayCaster).toBeInstanceOf(Raycaster)
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('MavonEngine'))
  })

  it('should call physics step and update callbacks on update()', () => {
    const game = new BaseGame(mockLogger, mockPhysicsWorld)
    game.update(0)
    expect(mockPhysicsWorld.step).toHaveBeenCalled()
  })

  it('should add update callbacks via onUpdate()', () => {
    const game = new BaseGame(mockLogger)
    const callback = vi.fn()

    game.onUpdate(callback)
    game.update(0.02)

    expect(callback).toHaveBeenCalledWith(0.02)
  })

  it('should return the singleton instance', () => {
    const game = new BaseGame()
    expect(BaseGame.instance()).toBe(game)
  })

  it('should log emergency on destroy', () => {
    const game = new BaseGame(mockLogger)
    game.destroy()

    expect(mockLogger.emerg).toHaveBeenCalledWith('Destroy called on server game instance')
  })
})
