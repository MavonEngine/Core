// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react'
import { Object3D, Scene, Vector3 } from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Assets from '../../../src/Editor/UI/Assets/Assets'
import SceneExplorer from '../../../src/Editor/UI/SceneExplorer'
import Game from '@mavonengine/core/Game'
import EventEmitter from '@mavonengine/core/Utils/EventEmitter'

vi.mock('../../../src/Editor/UI/SceneExplorer.module.css', () => ({ default: {} }))
vi.mock('../../../src/Editor/UI/Assets/Assets.module.css', () => ({ default: {} }))
vi.mock('../../../src/Editor/UI/Window', () => ({ default: () => null }))
vi.mock('../../../src/Editor/UI/Assets/AudioPlayer', () => ({ default: () => null }))
vi.mock('../../../src/Editor/UI/Assets/ModelViewer', () => ({ default: () => null }))
vi.mock('../../../src/Editor/UI/Assets/ParticleViewer', () => ({ default: () => null }))
vi.mock('../../../src/Editor/UI/Assets/TextureViewer', () => ({
  default: () => null,
  getTextureUrl: () => '',
}))
vi.mock('@mavonengine/core/Editor/EditorHelper', () => ({ default: { from: () => null } }))
vi.mock('@mavonengine/core/Renderer/AssetRenderer', () => ({
  default: vi.fn().mockImplementation(() => ({ render: vi.fn().mockReturnValue('') })),
}))
vi.mock('@mavonengine/core/Prefab/Water/Water', () => ({
  default: vi.fn().mockImplementation(() => ({ material: {} })),
}))
vi.mock('@mavonengine/core/Prefab/Water/WaterManager', () => ({
  default: { instance: null, init: vi.fn() },
}))
vi.mock('@mavonengine/core/Prefab/Grass/Grass', () => ({
  default: vi.fn().mockImplementation(() => ({ addBindings: vi.fn() })),
}))
vi.mock('@mavonengine/core/Particles/System/ParticlePreviewRegistry', () => ({
  getPreviewMap: () => ({}),
  spawnParticle: vi.fn().mockReturnValue(new Object3D()),
  registerParticle: vi.fn(),
}))
vi.mock('@mavonengine/core/Game', () => ({
  default: { instance: vi.fn() },
}))

class MockEditor extends EventEmitter {
  activeAssetCategory = 'GLTF' as const
  availableAssetCategories: string[] = ['GLTF']
  setActiveAssetCategory = vi.fn()
  selectObject = vi.fn()
}

function makeGame(editor: MockEditor, scene: Scene) {
  const canvas = document.createElement('canvas')
  canvas.getBoundingClientRect = () =>
    ({ left: 0, top: 0, right: 800, bottom: 600, width: 800, height: 600, x: 0, y: 0, toJSON: () => {} } as DOMRect)
  return {
    scene,
    canvas,
    editor,
    resources: { items: {} as Record<string, any>, sources: [] as any[] },
    world: { add: vi.fn() },
    rayCaster: {
      setFromCamera: vi.fn(),
      ray: { intersectPlane: vi.fn().mockReturnValue(new Vector3()) },
      intersectObjects: vi.fn().mockReturnValue([]),
    },
    camera: { instance: {} },
    logger: { info: vi.fn(), warn: vi.fn() },
  }
}

function createDropEvent(mimeType: string, data: string) {
  const event = new Event('drop', { bubbles: true, cancelable: true })
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      types: [mimeType, 'text/plain'],
      getData: (type: string) => (type === mimeType ? data : ''),
    },
  })
  return event
}

describe('dropped assets appear in SceneExplorer', () => {
  let editor: MockEditor
  let scene: Scene
  let game: ReturnType<typeof makeGame>

  beforeEach(() => {
    editor = new MockEditor()
    scene = new Scene()
    game = makeGame(editor, scene)
    ;(window as any).Game = game
    vi.mocked(Game.instance).mockReturnValue(game as any)
  })

  afterEach(() => {
    cleanup()
  })

  describe('sceneExplorer responds to assetDropped', () => {
    it('shows empty state when scene has no visible objects', () => {
      render(<SceneExplorer />)
      screen.getByText('Scene is empty')
    })

    it('shows a newly added object after assetDropped fires', () => {
      render(<SceneExplorer />)

      const obj = new Object3D()
      obj.name = 'DroppedObject'
      scene.add(obj)

      act(() => {
        editor.trigger('assetDropped')
      })

      screen.getByText('DroppedObject')
    })

    it('shows multiple objects added before assetDropped fires', () => {
      render(<SceneExplorer />)

      const a = new Object3D()
      a.name = 'Alpha'
      const b = new Object3D()
      b.name = 'Beta'
      scene.add(a)
      scene.add(b)

      act(() => {
        editor.trigger('assetDropped')
      })

      screen.getByText('Alpha')
      screen.getByText('Beta')
    })

    it('does not show objects marked as editor-internal', () => {
      render(<SceneExplorer />)

      const internal = new Object3D()
      internal.name = 'EditorGizmo'
      internal.userData.isEditorInternal = true
      scene.add(internal)

      const visible = new Object3D()
      visible.name = 'VisibleObject'
      scene.add(visible)

      act(() => {
        editor.trigger('assetDropped')
      })

      expect(screen.queryByText('EditorGizmo')).toBeNull()
      screen.getByText('VisibleObject')
    })

    it('clears objects from SceneExplorer when removed from scene before assetDropped', () => {
      render(<SceneExplorer />)

      const obj = new Object3D()
      obj.name = 'Temporary'
      scene.add(obj)
      act(() => {
        editor.trigger('assetDropped')
      })
      screen.getByText('Temporary')

      scene.remove(obj)
      act(() => {
        editor.trigger('assetDropped')
      })
      expect(screen.queryByText('Temporary')).toBeNull()
    })
  })

  describe('assets drop handler → SceneExplorer integration', () => {
    it('gLTF asset dropped on canvas appears in SceneExplorer', () => {
      const gltfScene = new Object3D()
      gltfScene.name = 'MyGLTFModel'
      game.resources.items.model = { scene: gltfScene }

      render(
        <>
          <Assets />
          <SceneExplorer />
        </>,
      )

      act(() => {
        game.canvas.dispatchEvent(
          createDropEvent('application/mavonengine-resource', 'model'),
        )
      })

      screen.getByText('MyGLTFModel')
    })

    it('dropping a non-existent resource key leaves SceneExplorer empty', () => {
      render(
        <>
          <Assets />
          <SceneExplorer />
        </>,
      )

      act(() => {
        game.canvas.dispatchEvent(
          createDropEvent('application/mavonengine-resource', 'doesNotExist'),
        )
      })

      screen.getByText('Scene is empty')
    })

    it('triggers assetDropped event when a GLTF asset is dropped', () => {
      const gltfScene = new Object3D()
      game.resources.items.model2 = { scene: gltfScene }

      render(<Assets />)

      const handler = vi.fn()
      editor.on('assetDropped', handler)

      act(() => {
        game.canvas.dispatchEvent(
          createDropEvent('application/mavonengine-resource', 'model2'),
        )
      })

      expect(handler).toHaveBeenCalled()
    })

    it('particle dropped on canvas calls world.add and triggers assetDropped', () => {
      render(
        <>
          <Assets />
          <SceneExplorer />
        </>,
      )

      const handler = vi.fn()
      editor.on('assetDropped', handler)

      act(() => {
        game.canvas.dispatchEvent(
          createDropEvent('application/mavonengine-particle', 'Rain'),
        )
      })

      expect(game.world.add).toHaveBeenCalled()
      expect(handler).toHaveBeenCalled()
    })

    it('drop event with no matching resource does not call world.add', () => {
      render(<Assets />)

      act(() => {
        game.canvas.dispatchEvent(
          createDropEvent('application/mavonengine-resource', 'ghost'),
        )
      })

      expect(game.world.add).not.toHaveBeenCalled()
    })
  })
})
