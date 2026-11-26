import { Object3D, Scene, Vector3 } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Camera from '../src/Camera'

const mockGame = {
  sizes: {
    width: 800,
    height: 600,
  },
  scene: new Scene(),
  renderer: {
    xrPresenting: false,
  },
}

vi.mock('../src/Game', () => ({
  default: {
    instance: () => mockGame,
  },
}))

function expectClose(actual: Vector3, expected: Vector3) {
  expect(actual.distanceTo(expected)).toBeLessThan(1e-6)
}

/** The world direction the camera looks in, flattened onto the ground */
function heading(camera: Camera) {
  const direction = camera.instance.getWorldDirection(new Vector3())
  direction.y = 0
  return direction.normalize()
}

describe('camera', () => {
  let camera: Camera

  beforeEach(() => {
    mockGame.scene = new Scene()
    mockGame.renderer.xrPresenting = false
    camera = new Camera(new Object3D() as any)
  })

  it('puts the camera in a rig in the scene, at the same spot as before', () => {
    expect(camera.instance.parent).toBe(camera.rig)
    expect(camera.rig.parent).toBe(mockGame.scene)
    expectClose(camera.worldPosition, new Vector3(6, 4, 8))
  })

  it('reports the camera\'s world position once the rig moved', () => {
    camera.rig.position.set(10, 0, 0)
    camera.updateWorldPosition()

    expectClose(camera.worldPosition, new Vector3(16, 4, 8))
  })

  it('places the view and looks at the target on desktop', () => {
    const position = new Vector3(0, 5, 10)
    const target = new Vector3(0, 0, 0)
    camera.place(position, target)

    expectClose(camera.worldPosition, position)
    expectClose(camera.instance.getWorldDirection(new Vector3()), target.clone().sub(position).normalize())
  })

  it('keeps the heading when told not to turn', () => {
    camera.place(new Vector3(0, 2, 10), new Vector3(0, 0, 0))
    camera.place(new Vector3(5, 2, 10), new Vector3(100, 0, 0), { turn: false })

    expectClose(camera.worldPosition, new Vector3(5, 2, 10))
    expectClose(heading(camera), new Vector3(0, 0, -1))
  })

  it('turns around the camera without moving it', () => {
    camera.place(new Vector3(3, 2, 10), new Vector3(3, 2, 0))
    camera.turn(Math.PI / 2)

    expectClose(camera.worldPosition, new Vector3(3, 2, 10))
    expectClose(heading(camera), new Vector3(-1, 0, 0))
  })

  describe('in VR', () => {
    beforeEach(() => {
      mockGame.renderer.xrPresenting = true
      // Where the headset put the head, relative to the rig: standing 1.7m tall, half a meter right of its center
      camera.instance.position.set(0.5, 1.7, 0)
      camera.instance.quaternion.identity()
    })

    it('only turns the rig around the vertical axis, leaving the look direction to the headset', () => {
      camera.place(new Vector3(0, 5, 10), new Vector3(10, 0, 10))

      const euler = camera.rig.rotation
      expect(Math.abs(euler.x)).toBeLessThan(1e-6)
      expect(Math.abs(euler.z)).toBeLessThan(1e-6)
      expectClose(heading(camera), new Vector3(1, 0, 0))
    })

    it('assumes a standing eye height until the headset\'s pose is measured', () => {
      camera.place(new Vector3(0, 5, 10), new Vector3(0, 5, 0))

      expectClose(camera.rig.position, new Vector3(0, 3.4, 10))
    })

    it('lines the measured head up with the position, without cancelling later head movement', () => {
      camera.afterRender()
      const position = new Vector3(0, 5, 10)
      camera.place(position, new Vector3(0, 5, 0))
      camera.updateWorldPosition()
      expectClose(camera.worldPosition, position)

      // The player leans: the view moves with them, the rig stays put
      camera.instance.position.set(0.8, 1.5, 0)
      const rigBefore = camera.rig.position.clone()
      camera.afterRender()
      camera.place(position, new Vector3(0, 5, 0))
      expectClose(camera.rig.position, rigBefore)

      // Until they recenter
      camera.recenter()
      camera.place(position, new Vector3(0, 5, 0))
      camera.updateWorldPosition()
      expectClose(camera.worldPosition, position)
    })

    it('measures the head again in the next session', () => {
      camera.afterRender()
      mockGame.renderer.xrPresenting = false
      camera.afterRender()

      mockGame.renderer.xrPresenting = true
      camera.instance.position.set(0, 1.2, 0)
      camera.afterRender()
      camera.place(new Vector3(0, 5, 10), new Vector3(0, 5, 0))

      expectClose(camera.rig.position, new Vector3(0, 3.8, 10))
    })
  })
})
