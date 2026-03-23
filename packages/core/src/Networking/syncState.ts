import type Actor from '../World/Actor'
import type NetworkedEntityState from './NetworkedEntityState'

// TODO tighten types. Should not need any here
export type StateFactory = (entity: any, previousState?: any) => NetworkedEntityState

/**
 * Compare the incoming state from the server with what is on the current entity.
 */
export function syncStateStack(
  entity: Actor & { state: NetworkedEntityState[] },
  networkStates: { stateName: string }[],
  factories: Record<string, StateFactory>,
) {
  let i = 0

  while (i < networkStates.length) {
    const desired = networkStates[i].stateName
    const current = entity.state[i]

    if (!current || current.stateName !== desired) {
      // Capture the state at index i before removing (for the factory)
      const stateBeingReplaced = entity.state[i]

      // Remove all states from index i onwards (they don't match)
      while (entity.state.length > i) {
        entity.state[entity.state.length - 1].leave()
      }

      // Get the previous state (if any) for suspending
      const prevState = entity.state[entity.state.length - 1]
      // Suspend the previous state when adding a new state on top
      prevState?.suspend()

      const factory = factories[desired]

      if (factory) {
        // Pass the state being replaced to the factory (e.g., one state depends on results from the last)
        const newState = factory(entity, stateBeingReplaced)
        entity.state.push(newState)
      }
    }

    i++
  }

  // Remove any extra states beyond what the server has
  while (entity.state.length > networkStates.length) {
    entity.state[entity.state.length - 1].leave()
  }
}
