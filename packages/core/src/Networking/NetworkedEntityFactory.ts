import type NetworkedActor from './NetworkedActor'

type EntityFactory = (id: string, data: Record<string, unknown>) => NetworkedActor
const registry = new Map<string, EntityFactory>()

export default class NetworkedEntityFactory {
  register(typeName: string, factory: EntityFactory) {
    registry.set(typeName, factory)
  }

  create(typeName: string, id: string, data: Record<string, unknown>): NetworkedActor | null {
    const factory = registry.get(typeName)

    return factory ? factory(id, data) : null
  }
}
