import type { Vector3 } from 'three'
import type NetworkedEntity from './NetworkedEntity'
import GameObject from '../World/GameObject'

export default abstract class NetworkedGameObject extends GameObject implements NetworkedEntity {
  abstract $typeName: string

  previousStateHash = ''
  needsSync = true

  constructor(id?: string, position?: Vector3, rotation?: Vector3, scale?: Vector3) {
    super(id, position, rotation, scale)
  }

  updateFromNetwork(_data: object): void {
    throw new Error('Not implemented')
  }

  markSyncd() {
    this.needsSync = false
  }

  /**
   * We need this so we can use instanceof on these instances
   */
  static [Symbol.hasInstance](instance: unknown) {
    if (!instance || typeof instance !== 'object')
      return false

    const candidate = instance as NetworkedEntity & GameObject

    return candidate instanceof GameObject
      && typeof candidate.$typeName === 'string'
      && typeof candidate.updateFromNetwork === 'function'
      && typeof candidate.markSyncd === 'function'
      && typeof candidate.needsSync === 'boolean'
      && typeof candidate.previousStateHash === 'string'
  }
}

type AbstractCtor<T = object> = abstract new (...args: any[]) => T

export function NetworkedGameObjectMixin<TBase extends AbstractCtor<GameObject>>(Base: TBase) {
  abstract class NetworkedGameObjectBase
    extends Base
    implements NetworkedEntity {
    abstract $typeName: string
    abstract updateFromNetwork(data: object): void

    previousStateHash = ''
    needsSync = true

    markSyncd() {
      this.needsSync = false
    }
  }

  return NetworkedGameObjectBase
}
