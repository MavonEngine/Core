import { beforeAll, describe, expect, it, vi } from 'vitest'
import BaseChunkManager from '../../src/World/BaseChunkManager'
import BaseGame from './../../src/BaseGame'
import BaseWorld from './../../src/World/BaseWorld'
import GameObject from './../../src/World/GameObject'

class TestChunkManager extends BaseChunkManager {
}

describe('base World tests', () => {
  beforeAll(() => {
    const _baseGame = new BaseGame()
  })

  it('update is called on objects added to world', () => {
    const world = new BaseWorld()
    const testItem = new class extends GameObject {
      update(_delta: number): void {

      }
    }()

    const updateCalled = vi.spyOn(testItem, 'update')
    world.add({ testItem })

    world.update(1)

    expect(updateCalled).toHaveBeenCalledOnce()
  })

  it('destroyed item gets garbage collected', () => {
    const world = new BaseWorld()
    const testItem = new class extends GameObject {
      update(_delta: number): void {

      }
    }()

    world.add({ testItem })

    expect(world.entities.length).toBe(1)

    testItem.destroy()
    world.update(1)

    expect(world.entities.length).toBe(0)
  })

  it('calls destroy on chunkmanager and added world items when destroyed', () => {
    const testChunkManager = new TestChunkManager()
    const testItem = new class extends GameObject {
      update(_delta: number): void {
        throw new Error('Method not implemented.')
      }
    }()

    const destroyChunkManager = vi.spyOn(testChunkManager, 'destroy')
    const destroyItem = vi.spyOn(testItem, 'destroy')

    const world = new class extends BaseWorld {
      constructor() {
        super()

        this.chunkManager = testChunkManager
      }
    }()

    world.add({ testItem })

    world.destroy()
    expect(destroyChunkManager).toHaveBeenCalledOnce()
    expect(destroyItem).toHaveBeenCalledOnce()
  })
})
