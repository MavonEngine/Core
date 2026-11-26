// @vitest-environment jsdom
import { Object3D, PerspectiveCamera, Scene, Vector3 } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import UILabel from '../../src/ui/UILabel'
import { stubCanvas } from './canvasStub'

const camera = new PerspectiveCamera()
const mockGame = {
  scene: new Scene(),
  renderer: { xrPresenting: false },
  camera: {
    instance: camera,
    worldPosition: new Vector3(),
  },
  canvas: document.createElement('canvas'),
}

vi.mock('../../src/Game', () => ({
  default: {
    instance: () => mockGame,
  },
}))

describe('objectLabel in VR', () => {
  beforeEach(() => {
    vi.restoreAllMocks()
    stubCanvas()
    mockGame.scene = new Scene()
    mockGame.renderer.xrPresenting = false
    document.body.innerHTML = ''
  })

  it('is drawn in the scene instead of the page while a headset plays, and back on the page after', () => {
    const entity = new Object3D()
    entity.position.set(0, 0, -10)
    const label = new UILabel(entity, 'Alice', 'Player')

    label.update(0.016)
    expect(document.body.contains(label.domElement)).toBe(true)
    expect(mockGame.scene.getObjectByName('TextLabel')).toBeUndefined()

    mockGame.renderer.xrPresenting = true
    label.update(0.016)
    expect(document.body.contains(label.domElement)).toBe(false)
    const text = mockGame.scene.getObjectByName('TextLabel') as any
    expect(text.text).toBe('Player\nAlice')
    expect(text.position.z).toBeCloseTo(-10)
    // drawn among the scene, kept readable at any distance
    expect(text.material.depthTest).toBe(true)
    expect(text.options.angularSize).toBeGreaterThan(0)

    mockGame.renderer.xrPresenting = false
    label.update(0.016)
    expect(text.parent).toBeNull()
    expect(document.body.contains(label.domElement)).toBe(true)

    label.destroy()
  })

  it('shows nothing in VR when xrText gives nothing', () => {
    class Hidden extends UILabel {
      protected xrText() {
        return undefined
      }
    }
    const label = new Hidden(new Object3D(), 'x')
    mockGame.renderer.xrPresenting = true
    label.update(0.016)
    expect(mockGame.scene.getObjectByName('TextLabel')).toBeUndefined()
  })
})
