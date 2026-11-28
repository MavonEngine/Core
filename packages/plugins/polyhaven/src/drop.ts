import type Game from '@mavonengine/core/Game'
import type { Object3D } from 'three'
import type { DropHandler } from './panel'
import type { ImportedAsset } from './shared'
import { Mesh, Plane, Vector2, Vector3 } from 'three'
import { modelResource } from './shared'

/*
 * Dropping a Poly Haven card on the viewport: a model is placed where it lands, a texture's material graph goes on the
 * primitive it lands on. Both through the active scene, so saving the scene keeps them.
 */

/** The scene object type of a glTF resource placed in a scene, `MODEL_TYPE` in core's builtinSceneObjects */
const MODEL_TYPE = 'Model'
const PRIMITIVE_PREFIX = 'Primitive:'

type DropGame = Pick<Game, 'activeScene' | 'rayCaster' | 'camera' | 'scene' | 'canvas'>

export interface DropTarget {
  /** Where the cursor's ray meets the ground (y = 0), where the editor places dropped assets too */
  ground?: [number, number, number]
  /** The id of the scene object under the cursor, with its type */
  object?: { id: string, type: string }
}

/** What was under the cursor, worked out on the drop: the import that follows takes a while */
export function dropTarget(game: DropGame, clientX: number, clientY: number): DropTarget {
  const rect = game.canvas.getBoundingClientRect()
  game.rayCaster.setFromCamera(new Vector2(
    ((clientX - rect.left) / rect.width) * 2 - 1,
    -((clientY - rect.top) / rect.height) * 2 + 1,
  ), game.camera.instance)

  const target: DropTarget = {}
  const ground = new Vector3()
  if (game.rayCaster.ray.intersectPlane(new Plane(new Vector3(0, 1, 0), 0), ground))
    target.ground = ground.toArray()

  const scene = game.activeScene
  if (scene) {
    // The nearest mesh that is part of the scene, past helpers and gizmos
    for (const hit of game.rayCaster.intersectObjects(game.scene.children, true)) {
      if (!(hit.object instanceof Mesh))
        continue
      const entry = scene.entryOfObject3D(hit.object as Object3D)
      if (entry) {
        target.object = { id: entry.data.id, type: entry.data.type }
        break
      }
    }
  }
  return target
}

/** Put an import where it was dropped. Returns what happened, throws when it can't go there */
export function placeDropped(game: Pick<Game, 'activeScene'>, entry: ImportedAsset, target: DropTarget): string {
  const scene = game.activeScene
  if (!scene)
    throw new Error(`Imported ${entry.name}. Open a scene to drop it in`)

  if (entry.kind === 'models') {
    if (!target.ground)
      throw new Error(`Imported ${entry.name}. Drop it on the ground to place it`)
    const placed = scene.create(MODEL_TYPE, {
      name: entry.name,
      transform: {
        position: target.ground,
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      props: {
        resource: modelResource(entry.id),
      },
    })
    if (!placed)
      throw new Error(`Could not place ${entry.name}`)
    return `Placed ${entry.name} at ${target.ground.map(n => n.toFixed(1)).join(', ')}`
  }

  const object = target.object
  if (!object?.type.startsWith(PRIMITIVE_PREFIX))
    throw new Error(`Imported ${entry.name}. Drop it on a primitive (a plane, box, sphere…) to give it the material`)
  scene.setProps(object.id, { materialGraph: entry.graph })
  return `Gave ${object.id} the material ${entry.graph}`
}

/** The panel's drop handler for this game */
export function dropHandler(game: Game, afterPlace: () => void): DropHandler<DropTarget> {
  return {
    canvas: game.canvas,
    target: (x, y) => dropTarget(game, x, y),
    place: (entry, target) => {
      const message = placeDropped(game, entry, target)
      afterPlace()
      return message
    },
  }
}
