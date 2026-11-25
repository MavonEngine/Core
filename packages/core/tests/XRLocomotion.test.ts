import { Object3D, Scene, Vector2, Vector3 } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Camera from '../src/Camera'
import XRLocomotion from '../src/XRLocomotion'

const mockGame = {
  sizes: {
    width: 800,
    height: 600,
  },
  scene: new Scene(),
  renderer: {
    xrPresenting: true,
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

function heading(camera: Camera) {
  const direction = camera.instance.getWorldDirection(new Vector3())
  direction.y = 0
  return direction.normalize()
}

describe('xr locomotion', () => {
  let camera: Camera
  let input: { left: { stick: Vector2 }, right: { stick: Vector2 } }

  beforeEach(() => {
    mockGame.scene = new Scene()
    camera = new Camera(new Object3D() as any)
    // Standing at the rig's center, looking forward (-Z)
    camera.instance.position.set(0, 1.6, 0)
    camera.instance.quaternion.identity()
    input = {
      left: {
        stick: new Vector2(),
      },
      right: {
        stick: new Vector2(),
      },
    }
  })

  function locomotion(options?: ConstructorParameters<typeof XRLocomotion>[2]) {
    return new XRLocomotion(camera, input as any, options)
  }

  it('walks where the head looks, level with the ground', () => {
    // Looking left and down at the floor
    camera.instance.rotation.set(-0.8, Math.PI / 2, 0, 'YXZ')
    input.left.stick.set(0, 1)

    locomotion({ speed: 2 }).update(0.5)

    expectClose(camera.rig.position, new Vector3(-1, 0, 0))
  })

  it('strafes with the stick pushed sideways', () => {
    input.left.stick.set(1, 0)
    locomotion({ speed: 1 }).update(1)

    expectClose(camera.rig.position, new Vector3(1, 0, 0))
  })

  it('follows the head up and down when flying', () => {
    camera.instance.rotation.set(Math.PI / 2, 0, 0)
    input.left.stick.set(0, 1)
    locomotion({ speed: 1, fly: true }).update(1)

    expectClose(camera.rig.position, new Vector3(0, 1, 0))
  })

  it('snap turns once per flick, around the head', () => {
    const loco = locomotion()
    camera.updateWorldPosition()
    const head = camera.worldPosition.clone()

    input.right.stick.set(0.9, 0)
    loco.update(0.016)
    loco.update(0.016)
    loco.update(0.016)

    // Turned right by one step, standing where it was
    const expected = new Vector3(0, 0, -1).applyAxisAngle(new Vector3(0, 1, 0), -Math.PI / 6)
    expectClose(heading(camera), expected)
    expectClose(camera.worldPosition, head)

    // Let go and flick again
    input.right.stick.set(0.1, 0)
    loco.update(0.016)
    input.right.stick.set(0.9, 0)
    loco.update(0.016)
    expectClose(heading(camera), new Vector3(0, 0, -1).applyAxisAngle(new Vector3(0, 1, 0), -Math.PI / 3))
  })

  it('turns continuously when smooth', () => {
    input.right.stick.set(-1, 0)
    locomotion({ turn: 'smooth', turnSpeed: Math.PI / 2 }).update(1)

    expectClose(heading(camera), new Vector3(-1, 0, 0))
  })

  it('leaves turning to the player when off, and does nothing while disabled', () => {
    input.right.stick.set(1, 0)
    locomotion({ turn: false }).update(1)
    expectClose(heading(camera), new Vector3(0, 0, -1))

    const disabled = locomotion()
    disabled.enabled = false
    input.left.stick.set(0, 1)
    disabled.update(1)
    expectClose(camera.rig.position, new Vector3(0, 0, 0))
  })

  it('gives a third person game the stick\'s direction in the world', () => {
    camera.instance.rotation.set(0, Math.PI, 0)
    const direction = locomotion().getMoveDirection(new Vector2(0, 0.5))

    expectClose(direction, new Vector3(0, 0, 0.5))
  })
})
