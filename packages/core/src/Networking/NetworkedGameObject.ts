import type { Vector3Like } from 'three'
import type NetworkedEntity from './NetworkedEntity'
import GameObject from '../World/GameObject'

type AbstractCtor<T = object> = abstract new (...args: any[]) => T

export function NetworkedGameObjectMixin<TBase extends AbstractCtor<GameObject>>(Base: TBase) {
  abstract class NetworkedGameObjectBase
    extends Base
    implements NetworkedEntity {
    abstract $typeName: string

    previousStateHash = ''
    needsSync = true

    /**
     * This is the reverse of serialize on GameObject.
     * This way we can parse the values back from the network serialization into our
     * current entity.
     *
     * Once it gets the data in from the server it loops through the entities networkedFieldCallbacks
     * and assigns the values.
     *
     * After the values have been set you can then do what you need to do
     * in the entity.update() method.
     */
    updateFromNetwork(data: Record<string, unknown>): void {
      Object.entries(this.networkedFieldCallbacks()).forEach(([name, cb]) => {
        if (name in data) {
          cb(data[name])
        }
      })
    }

    networkedFieldCallbacks(): Record<string, (value: unknown) => void> {
      return {
        position: pos => this.position.set((pos as Vector3Like).x, (pos as Vector3Like).y, (pos as Vector3Like).z),
        rotation: rot => this.rotation.set((rot as Vector3Like).x, (rot as Vector3Like).y, (rot as Vector3Like).z),
        scale: scale => this.scale.set((scale as Vector3Like).x, (scale as Vector3Like).y, (scale as Vector3Like).z),
      }
    }

    markSyncd() {
      this.needsSync = false
    }
  }

  return NetworkedGameObjectBase
}

export default abstract class NetworkedGameObject extends NetworkedGameObjectMixin(GameObject) {
  abstract $typeName: string

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
