import type Game from '@mavonengine/core/Game'
import type { ImportedAsset } from '../src/shared'
import { BoxGeometry, Mesh, MeshBasicMaterial, PerspectiveCamera, Raycaster, Scene } from 'three'
import { describe, expect, it, vi } from 'vitest'
import { dropTarget, placeDropped } from '../src/drop'

const model: ImportedAsset = {
  id: 'crate',
  kind: 'models',
  name: 'Crate',
  resolution: '1k',
  files: { gltf: '/polyhaven/crate/crate_1k.gltf' },
}
const texture: ImportedAsset = {
  id: 'rock',
  kind: 'textures',
  name: 'Rock',
  resolution: '1k',
  files: { diff: '/d.jpg' },
  graph: 'polyhaven_rock',
}

function fakeScene() {
  return {
    create: vi.fn(() => ({
      data: { id: 'Model_1' },
    })),
    setProps: vi.fn(),
    entryOfObject3D: vi.fn((object: { userData: { sceneObjectId?: string } } | null) => {
      for (let o = object as any; o; o = o.parent) {
        if (o.userData.sceneObjectId) {
          return {
            data: { id: o.userData.sceneObjectId, type: o.userData.type },
          }
        }
      }
      return undefined
    }),
  }
}

describe('placeDropped', () => {
  it('places a model where it landed on the ground', () => {
    const scene = fakeScene()
    const message = placeDropped({ activeScene: scene } as unknown as Game, model, {
      ground: [1, 0, 2],
    })
    expect(scene.create).toHaveBeenCalledWith('Model', {
      name: 'Crate',
      transform: {
        position: [1, 0, 2],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      props: { resource: 'polyhaven_crate' },
    })
    expect(message).toBe('Placed Crate at 1.0, 0.0, 2.0')
  })

  it('gives the primitive a texture landed on its material graph', () => {
    const scene = fakeScene()
    placeDropped({ activeScene: scene } as unknown as Game, texture, {
      object: { id: 'ground', type: 'Primitive:Plane' },
    })
    expect(scene.setProps).toHaveBeenCalledWith('ground', { materialGraph: 'polyhaven_rock' })
  })

  it('says why it can\'t place it', () => {
    const scene = fakeScene()
    const game = { activeScene: scene } as unknown as Game
    expect(() => placeDropped(game, texture, {
      ground: [0, 0, 0],
    })).toThrow(/Drop it on a primitive/)
    expect(() => placeDropped(game, texture, {
      object: { id: 'm', type: 'Model' },
    })).toThrow(/Drop it on a primitive/)
    expect(() => placeDropped(game, model, {})).toThrow(/on the ground/)
    expect(() => placeDropped({} as Game, model, {
      ground: [0, 0, 0],
    })).toThrow(/Open a scene/)
    expect(scene.setProps).not.toHaveBeenCalled()
    expect(scene.create).not.toHaveBeenCalled()
  })
})

describe('dropTarget', () => {
  it('finds the ground point and the scene object under the cursor, past helpers', () => {
    const camera = new PerspectiveCamera(60, 1, 0.1, 100)
    camera.position.set(0, 5, 5)
    camera.lookAt(0, 0, 0)
    camera.updateMatrixWorld()

    const scene = new Scene()
    const box = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial())
    box.userData = { sceneObjectId: 'box_1', type: 'Primitive:Box' }
    // A helper in front of it, not part of the scene file
    const helper = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshBasicMaterial())
    helper.position.set(0, 2.5, 2.5)
    scene.add(box, helper)
    scene.updateMatrixWorld()

    const game = {
      canvas: {
        getBoundingClientRect: () => ({
          left: 0,
          top: 0,
          width: 200,
          height: 200,
        }),
      },
      camera: { instance: camera },
      rayCaster: new Raycaster(),
      scene,
      activeScene: fakeScene(),
    } as unknown as Game

    const center = dropTarget(game, 100, 100)
    expect(center.object).toEqual({ id: 'box_1', type: 'Primitive:Box' })
    expect(center.ground!.map(n => Math.round(n * 100) / 100)).toEqual([0, 0, 0])

    // Off to the side: the ground, but no scene object
    const side = dropTarget(game, 0, 100)
    expect(side.ground).toBeDefined()
    expect(side.object).toBeUndefined()
  })
})
