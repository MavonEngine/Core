import type Chunk from './Chunk'
import type GameObjectInterface from './GameObjectInterface'

/**
 * This is the server representation. For the player see ChunkManager.ts
 */
export default class BaseChunkManager implements GameObjectInterface {
  loadedChunks = new Map<string, Chunk>()

  update(delta: number) {
    this.loadedChunks.forEach(chunk => chunk.update(delta))
  }

  destroy() {
    this.loadedChunks.forEach(chunk => chunk.destroy())
  }
}
