export default interface GameObjectInterface {
  update(delta: number): void

  destroy(): void
}
