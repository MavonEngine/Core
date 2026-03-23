import type GameObject from './GameObject'
import type GameObjectInterface from './GameObjectInterface'
import BaseGame from '../BaseGame'
import ChunkManager from './BaseChunkManager'

/**
 * The barebones representation of all the entities in our
 * world. This is the server world class. The client render is in World.ts
 */
export default class BaseWorld implements GameObjectInterface {
  chunkManager = new ChunkManager()

  /**
   * The game entities in the world, stored by ID
   */
  entities: {
    items: Map<string, GameObject>
    get length(): number
  } = {
    items: new Map(),
    get length() {
      return this.items.size
    },
  }

  /**
   * Add game objects by unique string IDs
   */
  add(objects: Record<string, GameObject>) {
    for (const [id, object] of Object.entries(objects)) {
      this.entities.items.set(id, object)
    }
  }

  update(delta: number): void {
    this.chunkManager.update(delta)

    for (const [id, item] of this.entities.items) {
      if (item.garbageCollect) {
        BaseGame.instance().logger?.debug('Destroying entity', item)
        item.destroy()

        this.entities.items.delete(id)
      }
      else {
        item.update(delta)
      }
    }
  }

  destroy() {
    this.chunkManager.destroy()
    this.entities.items.forEach(item => item.destroy())
  }
}
