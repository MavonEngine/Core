import GameObject from './GameObject'

export default class Chunk extends GameObject {
  public serialize(): object {
    throw new Error('Method not implemented.')
  }

  static CHUNK_SIZE: number

  constructor(x: number, y: number) {
    super(`chunk_${x},${y}`)

    this.position.set(x, 0, y)
  }

  update(_delta: number): void {
  }
}
