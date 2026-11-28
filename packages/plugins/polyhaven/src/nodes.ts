import type { TslImplementation } from '@mavonengine/core/Graph/Material/tslNodes'
import type { NodeDefinition } from '@mavonengine/core/Graph/NodeRegistry'
import { normalMap, normalView, vec2 } from 'three/tsl'

/** The Normal Map node, registered as `@mavonengine/polyhaven:normalMap` (see `NORMAL_MAP_NODE`) */
export const normalMapNode: Omit<NodeDefinition, 'plugin'> = {
  type: 'normalMap',
  label: 'Normal Map',
  category: 'Texture',
  description: 'A tangent space normal map (OpenGL, green up) as the surface normal, for the Material Output\'s Normal',
  kinds: ['material'],
  inputs: {
    color: { type: 'color', label: 'Map' },
    strength: { type: 'float', default: 1, label: 'Strength' },
  },
  outputs: {
    normal: { type: 'vec3' },
  },
}

/** Unconnected, the mesh's own normal */
export const normalMapTsl: TslImplementation = ({ color, strength }, { connected }) => ({
  normal: connected.has('color')
    ? normalMap(color, vec2(strength, strength))
    : normalView,
})
