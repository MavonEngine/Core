import type { Mesh } from 'three'
import type GameObjectInterface from './GameObjectInterface'
import { Vector3 } from 'three'
import Entity from '../Networking/Server/Client'

export default abstract class GameObject extends Entity implements GameObjectInterface {
  garbageCollect = false

  position: Vector3
  rotation: Vector3
  scale: Vector3

  colliderMesh?: Mesh

  constructor(id?: string, position = new Vector3(), rotation = new Vector3(), scale = new Vector3(1),
  ) {
    super(id)

    this.position = position
    this.scale = scale
    this.rotation = rotation
    this.rotation.add(rotation)
  }

  get message() {
    return this.id
  }

  abstract update(delta: number): void

  public serialize() {
    return {
      id: this.id,
      position: this.position,
      rotation: this.rotation,
      scale: this.scale,
    }
  }

  destroy() {
    this.garbageCollect = true
  }
}
