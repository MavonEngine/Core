import Game from '@mavonengine/core/Game'
import { Matrix4, Mesh, Object3D, Vector3 } from 'three'
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

import Editor from '../src/Editor'

/**
 * Create by claude 4.6
 */

// Provide minimal DOM globals for the node test environment
beforeAll(() => {
  ;(globalThis as any).window = { innerWidth: 800, innerHeight: 600 }
  const mockBody = { removeAttribute: vi.fn() }
  const mockElement = {
    classList: { add: vi.fn() },
    style: {},
    textContent: '',
    appendChild: vi.fn(),
    addEventListener: vi.fn(),
  }
    ;(globalThis as any).document = {
    getElementsByTagName: () => [mockBody],
    createElement: vi.fn().mockReturnValue(mockElement),
    body: { contains: vi.fn().mockReturnValue(false), appendChild: vi.fn() },
  }
})

vi.mock('three/examples/jsm/Addons.js', () => ({
  FlyControls: vi.fn().mockImplementation(() => ({
    autoForward: false,
    dragToLook: false,
    movementSpeed: 0,
    rollSpeed: 0,
    update: vi.fn(),
  })),
  OutlinePass: vi.fn().mockImplementation(() => ({
    selectedObjects: [] as Object3D[],
    dispose: vi.fn(),
  })),
  TransformControls: vi.fn().mockImplementation(() => ({
    addEventListener: vi.fn(),
    getHelper: vi.fn().mockReturnValue(new Object3D()),
    setMode: vi.fn(),
    attach: vi.fn(),
    detach: vi.fn(),
  })),
}))

vi.mock('../src/Editor/mount', () => ({
  mountEditorUI: vi.fn().mockReturnValue({ unmount: vi.fn() }),
}))

vi.mock('@mavonengine/core/Game', () => ({
  default: { instance: vi.fn() },
}))

function createMockGame() {
  return {
    logger: { info: vi.fn() },
    trigger: vi.fn(),
    world: { destroy: vi.fn(), add: vi.fn() },
    scene: {
      traverse: vi.fn(),
      clear: vi.fn(),
      add: vi.fn(),
      remove: vi.fn(),
      children: [] as Object3D[],
    },
    contextMenuAbort: { abort: vi.fn() },
    uiRoot: { innerHTML: '', style: { opacity: '' } },
    camera: {
      instance: {
        position: { set: vi.fn(), x: 0, y: 0, z: 0 },
        rotation: { set: vi.fn() },
        rotateY: vi.fn(),
        rotateX: vi.fn(),
        getWorldDirection: vi.fn().mockReturnValue(new Vector3()),
        quaternion: { setFromRotationMatrix: vi.fn() },
        projectionMatrix: new Matrix4(),
        matrixWorldInverse: new Matrix4(),
      },
    },
    renderer: {
      composer: { addPass: vi.fn() },
    },
    sizes: { width: 800, height: 600 },
    canvas: { getBoundingClientRect: vi.fn().mockReturnValue({ left: 0, top: 0, width: 800, height: 600 }) },
    input: {
      on: vi.fn(),
      getPointerWorldPosition: vi.fn(),
    },
    resources: {
      items: {} as Record<string, object>,
    },
    editor: undefined as Editor | undefined,
  }
}

describe('editor', () => {
  let mockGame: ReturnType<typeof createMockGame>

  beforeEach(() => {
    mockGame = createMockGame()
    vi.mocked(Game.instance).mockReturnValue(mockGame as any)
  })

  describe('registerListener', () => {
    it('registers a keydown listener on the input manager', () => {
      Editor.registerListener()

      expect(mockGame.input.on).toHaveBeenCalledWith('keydown', expect.any(Function))
    })

    it('creates an Editor and assigns it when Insert key is pressed', () => {
      expect(mockGame.editor).toBeUndefined()

      Editor.registerListener()

      const [[, callback]] = vi.mocked(mockGame.input.on).mock.calls.filter(([event]) => event === 'keydown')
      callback({ code: 'Insert' } as KeyboardEvent)

      expect(mockGame.editor).toBeInstanceOf(Editor)
    })

    it('creates an Editor and assigns it when Period key is pressed', () => {
      expect(mockGame.editor).toBeUndefined()

      Editor.registerListener()

      const [[, callback]] = vi.mocked(mockGame.input.on).mock.calls.filter(([event]) => event === 'keydown')
      callback({ code: 'Period' } as KeyboardEvent)

      expect(mockGame.editor).toBeInstanceOf(Editor)
    })

    it('does not create an Editor for other keys', () => {
      Editor.registerListener()

      const [[, callback]] = vi.mocked(mockGame.input.on).mock.calls.filter(([event]) => event === 'keydown')
      callback({ code: 'Space' } as KeyboardEvent)

      expect(mockGame.editor).toBeUndefined()
    })
  })

  describe('constructor', () => {
    it('logs a boot message', () => {
      const _editor = new Editor()

      expect(mockGame.logger.info).toHaveBeenCalledWith('Booting Editor')
    })

    it('triggers editorBoot with itself', () => {
      const editor = new Editor()

      expect(mockGame.trigger).toHaveBeenCalledWith('editorBoot', editor)
    })

    it('triggers uiDestroy', () => {
      const _editor = new Editor()

      expect(mockGame.trigger).toHaveBeenCalledWith('uiDestroy', expect.anything())
    })

    it('destroys the world', () => {
      const _editor = new Editor()

      expect(mockGame.world.destroy).toHaveBeenCalled()
    })

    it('traverses and clears the scene', () => {
      const _editor = new Editor()

      expect(mockGame.scene.traverse).toHaveBeenCalled()
      expect(mockGame.scene.clear).toHaveBeenCalled()
    })

    it('aborts the context menu signal', () => {
      const _editor = new Editor()

      expect(mockGame.contextMenuAbort.abort).toHaveBeenCalled()
    })

    it('adds the outline pass to the renderer composer', () => {
      const _editor = new Editor()

      expect(mockGame.renderer.composer.addPass).toHaveBeenCalled()
    })

    it('sets the camera position', () => {
      const _editor = new Editor()

      expect(mockGame.camera.instance.position.set).toHaveBeenCalledWith(20, 10, 20)
    })

    it('registers mousedown and keydown listeners on input', () => {
      const _editor = new Editor()

      const events = vi.mocked(mockGame.input.on).mock.calls.map(([event]) => event)
      expect(events).toContain('mousedown')
      expect(events).toContain('keydown')
    })
  })

  describe('update', () => {
    it('delegates to flyControls.update with the given delta', () => {
      const editor = new Editor()

      editor.update(0.016)

      expect(editor.flyControls.update).toHaveBeenCalledWith(0.016)
    })
  })

  describe('destroy', () => {
    it('unmounts the react root', () => {
      const editor = new Editor()
      const mockUnmount = vi.fn()
      editor.reactRoot = { unmount: mockUnmount } as any

      editor.destroy()

      expect(mockUnmount).toHaveBeenCalled()
    })

    it('disposes the outline pass', () => {
      const editor = new Editor()
      editor.reactRoot = { unmount: vi.fn() } as any

      editor.destroy()

      expect(editor.outlinePass.dispose).toHaveBeenCalled()
    })
  })

  describe('handleCanvasClick', () => {
    it('selects the raycasted object on left click', () => {
      const mockObject = new Object3D()
      mockGame.input.getPointerWorldPosition = vi.fn().mockReturnValue(mockObject)
      const editor = new Editor()
      const selectedCb = vi.fn()
      editor.on('objectSelected', selectedCb)

      editor.handleCanvasClick({ button: 0 } as MouseEvent)

      expect(editor.activeItem).toBe(mockObject)
      expect(selectedCb).toHaveBeenCalledWith(mockObject)
      expect(editor.outlinePass.selectedObjects).toContain(mockObject)
    })

    it('clears the active item when left click hits nothing', () => {
      mockGame.input.getPointerWorldPosition = vi.fn().mockReturnValue(undefined)
      const editor = new Editor()
      editor.activeItem = new Object3D()

      editor.handleCanvasClick({ button: 0 } as MouseEvent)

      expect(editor.activeItem).toBeNull()
    })

    it('ignores non-left-click buttons', () => {
      mockGame.input.getPointerWorldPosition = vi.fn()
      const editor = new Editor()

      editor.handleCanvasClick({ button: 2 } as MouseEvent)

      expect(mockGame.input.getPointerWorldPosition).not.toHaveBeenCalled()
      expect(editor.activeItem).toBeUndefined()
    })
  })

  describe('handleItemDelete (via keydown listener)', () => {
    function getDeleteKeydownCallback() {
      // handleItemDelete registers the only keydown listener in the constructor
      const keydownCalls = vi.mocked(mockGame.input.on).mock.calls.filter(([event]) => event === 'keydown')
      return keydownCalls.at(-1)[1]
    }

    it('removes the active item from the scene on Delete', () => {
      const editor = new Editor()
      const callback = getDeleteKeydownCallback()

      const mockObject = new Object3D()
      mockObject.parent = mockGame.scene as any
      editor.activeItem = mockObject

      callback({ code: 'Delete' } as KeyboardEvent)

      expect(mockGame.scene.remove).toHaveBeenCalledWith(mockObject)
    })

    it('clears outlinePass selection and activeItem on Delete', () => {
      const editor = new Editor()
      const callback = getDeleteKeydownCallback()

      const mockObject = new Object3D()
      mockObject.parent = mockGame.scene as any
      editor.activeItem = mockObject
      editor.outlinePass.selectedObjects = [mockObject]

      callback({ code: 'Delete' } as KeyboardEvent)

      expect(editor.outlinePass.selectedObjects).toEqual([])
      expect(editor.activeItem).toBeNull()
    })

    it('traverses up to the scene root before removing', () => {
      const editor = new Editor()
      const callback = getDeleteKeydownCallback()

      const child = new Object3D()
      const parent = new Object3D()
      parent.parent = mockGame.scene as any
      child.parent = parent
      editor.activeItem = child

      callback({ code: 'Delete' } as KeyboardEvent)

      expect(mockGame.scene.remove).toHaveBeenCalledWith(parent)
    })

    it('does nothing when there is no active item', () => {
      const editor = new Editor()
      const callback = getDeleteKeydownCallback()
      editor.activeItem = null

      callback({ code: 'Delete' } as KeyboardEvent)

      expect(mockGame.scene.remove).not.toHaveBeenCalled()
    })

    it('does nothing for non-Delete keys', () => {
      const editor = new Editor()
      const callback = getDeleteKeydownCallback()

      const mockObject = new Object3D()
      editor.activeItem = mockObject

      callback({ code: 'Escape' } as KeyboardEvent)

      expect(mockGame.scene.remove).not.toHaveBeenCalled()
      expect(editor.activeItem).toBe(mockObject)
    })

    it('disposes geometry and materials of Mesh children on delete', () => {
      const editor = new Editor()
      const callback = getDeleteKeydownCallback()

      const mockGeometry = { dispose: vi.fn() }
      const mockMaterial = { dispose: vi.fn() }
      const mesh = new Mesh()
      mesh.geometry = mockGeometry as any
      mesh.material = mockMaterial as any
      mesh.parent = mockGame.scene as any
      editor.activeItem = mesh

      callback({ code: 'Delete' } as KeyboardEvent)

      expect(mockGeometry.dispose).toHaveBeenCalled()
      expect(mockMaterial.dispose).toHaveBeenCalled()
    })
  })
})
