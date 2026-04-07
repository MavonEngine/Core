import type NetworkedActor from './NetworkedActor'

type EntityFactory = (data: Record<string, unknown>) => NetworkedActor
const registry = new Map<string, EntityFactory>()

export default class NetworkedEntityFactory {
  private static _instance: NetworkedEntityFactory

  static get instance(): NetworkedEntityFactory {
    if (!NetworkedEntityFactory._instance) {
      NetworkedEntityFactory._instance = new NetworkedEntityFactory()
    }

    return NetworkedEntityFactory._instance
  }

  register(typeName: string, factory: EntityFactory) {
    registry.set(typeName, factory)
  }

  create(typeName: string, data: Record<string, unknown>): NetworkedActor | null {
    const factory = registry.get(typeName)

    return factory ? factory(data) : null
  }
}
