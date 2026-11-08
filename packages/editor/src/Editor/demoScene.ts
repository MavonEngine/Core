import type { SceneData, SceneObjectData } from '@mavonengine/core/Scene/types'
import { lightType, primitiveType } from '@mavonengine/core/Scene/builtinSceneObjects'
import { SCENE_FORMAT_VERSION } from '@mavonengine/core/Scene/types'

/** The scene the editor opens and saves when the game loaded none */
export const DEFAULT_SCENE_NAME = 'main'

function object(id: string, type: string, position: [number, number, number], props?: Record<string, unknown>): SceneObjectData {
  return { id, type, transform: { position, rotation: [0, 0, 0], scale: [1, 1, 1] }, ...(props ? { props } : {}) }
}

/**
 * Some shapes on a ground plane, to have something to look at in a new project
 */
export function demoScene(): SceneData {
  const r = 5
  const d = r * 0.707
  const shape = (id: string, name: string, position: [number, number, number]) => object(id, primitiveType(name), position, { castShadow: true })

  return {
    version: SCENE_FORMAT_VERSION,
    name: DEFAULT_SCENE_NAME,
    settings: {},
    objects: [
      object('ambient_light', lightType('AmbientLight'), [0, 5, 0]),
      object('sun', lightType('DirectionalLightShadow'), [10, 15, 5], { intensity: 5, castShadow: true }),
      object('ground', primitiveType('Plane'), [0, 0, 0], { width: 50, height: 50, color: '#ffbe6f', receiveShadow: true }),
      shape('box', 'Box', [r, 0.5, 0]),
      shape('sphere', 'Sphere', [d, 1, d]),
      shape('cone', 'Cone', [0, 0.5, r]),
      shape('cylinder', 'Cylinder', [-d, 0.5, d]),
      shape('octahedron', 'Octahedron', [-r, 1, 0]),
      shape('dodecahedron', 'Dodecahedron', [-d, 1, -d]),
      shape('capsule', 'Capsule', [0, 1, -r]),
      shape('icosahedron', 'Icosahedron', [d, 1, -d]),
      shape('torus_knot', 'TorusKnot', [0, 3.5, 0]),
    ],
  }
}
