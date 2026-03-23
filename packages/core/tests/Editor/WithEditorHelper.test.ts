import { Object3D, Vector3 } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { WithEditorHelper } from '../../src/Editor/WithEditorHelper'
import Game from '../../src/Game'

vi.mock('../../src/Game', () => ({
  default: { instance: vi.fn() },
}))

vi.mock('../../src/Editor/EditorHelper', () => ({
  default: vi.fn().mockImplementation((position, label, attachment) => ({
    position,
    label,
    attachment,
    owner: undefined as any,
    dispose: vi.fn(),
  })),
}))

function createMockEditor() {
  return {
    addHelper: vi.fn(),
    removeHelper: vi.fn(),
    selectObject: vi.fn(),
  }
}

function createMockGame(editor?: ReturnType<typeof createMockEditor>) {
  return {
    editor,
    scene: { add: vi.fn(), remove: vi.fn() },
  }
}

abstract class BaseObject {
  destroyed = false
  destroy(): void {
    this.destroyed = true
  }
}

class TestObject extends WithEditorHelper(BaseObject) {
  // concrete subclass for testing
}

describe('withEditorHelper', () => {
  let mockEditor: ReturnType<typeof createMockEditor>
  let mockGame: ReturnType<typeof createMockGame>

  beforeEach(() => {
    mockEditor = createMockEditor()
    mockGame = createMockGame(mockEditor)
    vi.mocked(Game.instance).mockReturnValue(mockGame as any)
  })

  describe('registerEditorHelper', () => {
    it('creates an EditorHelper and adds it to the editor', () => {
      const obj = new TestObject()
      const pos = new Vector3(1, 2, 3)

      obj.registerEditorHelper(pos, 'MyLabel')

      expect(mockEditor.addHelper).toHaveBeenCalledWith(obj.editorHelper)
      expect(obj.editorHelper).toBeDefined()
    })

    it('sets owner on the created EditorHelper', () => {
      const obj = new TestObject()

      obj.registerEditorHelper(new Vector3(), 'Test')

      expect(obj.editorHelper!.owner).toBe(obj)
    })

    it('passes the attachment to EditorHelper', () => {
      const obj = new TestObject()
      const attachment = { addBindings: vi.fn() }

      obj.registerEditorHelper(new Vector3(), 'WithAttachment', attachment)

      expect(obj.editorHelper!.attachment).toBe(attachment)
    })

    it('is a no-op when no editor is active', () => {
      mockGame = createMockGame(undefined)
      vi.mocked(Game.instance).mockReturnValue(mockGame as any)
      const obj = new TestObject()

      obj.registerEditorHelper(new Vector3(), 'NoEditor')

      expect(obj.editorHelper).toBeUndefined()
    })
  })

  describe('tagWithHelper', () => {
    it('sets editorHelper on mesh userData when helper exists', () => {
      const obj = new TestObject()
      obj.registerEditorHelper(new Vector3(), 'Tagged')
      const mesh = new Object3D()

      obj.tagWithHelper(mesh)

      expect(mesh.userData.editorHelper).toBe(obj.editorHelper)
    })

    it('does nothing when no helper has been registered', () => {
      const obj = new TestObject()
      const mesh = new Object3D()

      obj.tagWithHelper(mesh)

      expect(mesh.userData.editorHelper).toBeUndefined()
    })
  })

  describe('destroy', () => {
    it('removes the helper from the editor and disposes it', () => {
      const obj = new TestObject()
      obj.registerEditorHelper(new Vector3(), 'ToDestroy')
      const helper = obj.editorHelper!

      obj.destroy()

      expect(mockEditor.removeHelper).toHaveBeenCalledWith(helper)
      expect(helper.dispose).toHaveBeenCalled()
    })

    it('clears editorHelper reference after destroy', () => {
      const obj = new TestObject()
      obj.registerEditorHelper(new Vector3(), 'ToDestroy')

      obj.destroy()

      expect(obj.editorHelper).toBeUndefined()
    })

    it('calls super.destroy()', () => {
      const obj = new TestObject()
      obj.registerEditorHelper(new Vector3(), 'Super')

      obj.destroy()

      expect(obj.destroyed).toBe(true)
    })

    it('calls super.destroy() even when no helper was registered', () => {
      const obj = new TestObject()

      obj.destroy()

      expect(obj.destroyed).toBe(true)
    })

    it('does not call removeHelper when no editor is active at destroy time', () => {
      const obj = new TestObject()
      obj.registerEditorHelper(new Vector3(), 'NoEditorAtDestroy')

      // editor goes away before destroy
      mockGame.editor = undefined
      obj.destroy()

      expect(mockEditor.removeHelper).not.toHaveBeenCalled()
    })
  })
})
