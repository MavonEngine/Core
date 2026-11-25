import { Group, Mesh, MeshBasicMaterial, PlaneGeometry, Raycaster } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import XRInput, { XRControllerButton } from '../src/XRInput'

vi.mock('three/examples/jsm/webxr/XRControllerModelFactory.js', () => ({
  XRControllerModelFactory: vi.fn(function () {
    return {
      setPath: vi.fn(),
      createControllerModel: vi.fn(() => {
        const model = new Group()
        model.name = 'model'
        return model
      }),
    }
  }),
}))

function button(value: number) {
  return { pressed: value > 0.9, touched: value > 0, value }
}

function inputSource(handedness: XRHandedness, buttons: number[] = [], axes: number[] = [0, 0, 0, 0]) {
  return {
    handedness,
    gamepad: {
      buttons: buttons.map(button),
      axes,
      hapticActuators: [
        {
          pulse: vi.fn().mockResolvedValue(true),
        },
      ],
    },
  } as unknown as XRInputSource
}

function setup(options?: ConstructorParameters<typeof XRInput>[2]) {
  const rays = [
    new Group(),
    new Group(),
  ]
  const grips = [
    new Group(),
    new Group(),
  ]
  const xr = {
    getController: vi.fn((i: number) => rays[i]),
    getControllerGrip: vi.fn((i: number) => grips[i]),
  }
  const rig = new Group()
  const input = new XRInput(xr as any, rig, options)
  return { input, rays, grips, rig }
}

describe('xr input', () => {
  let ctx: ReturnType<typeof setup>

  beforeEach(() => {
    ctx = setup()
  })

  it('puts both controllers in the rig, with models and pointer lines', () => {
    for (let i = 0; i < 2; i++) {
      expect(ctx.rays[i].parent).toBe(ctx.rig)
      expect(ctx.grips[i].parent).toBe(ctx.rig)
      expect(ctx.grips[i].getObjectByName('model')).toBeDefined()
      expect(ctx.rays[i].getObjectByName('XRControllerRay')).toBeDefined()
    }
  })

  it('leaves models and lines out when asked', () => {
    const { rays, grips } = setup({ controllerModels: false, rays: false })
    expect(grips[0].children).toHaveLength(0)
    expect(rays[0].children).toHaveLength(0)
  })

  it('assigns controllers to hands by their handedness, not their slot', () => {
    const connected = vi.fn()
    ctx.input.on('connected', connected)

    // The session put the left hand in the second slot
    ctx.rays[1].dispatchEvent({
      type: 'connected',
      data: inputSource('left'),
    } as any)

    expect(ctx.input.left.connected).toBe(true)
    expect(ctx.input.right.connected).toBe(false)
    expect(ctx.input.left.ray).toBe(ctx.rays[1])
    expect(ctx.input.left.grip).toBe(ctx.grips[1])
    expect(connected).toHaveBeenCalledWith(ctx.input.left)
  })

  it('ignores input without a hand, like gaze', () => {
    ctx.rays[0].dispatchEvent({
      type: 'connected',
      data: inputSource('none'),
    } as any)
    expect(ctx.input.left.connected).toBe(false)
    expect(ctx.input.right.connected).toBe(false)
  })

  it('tracks buttons and the thumbstick, with Y positive pushed forward', () => {
    const source = inputSource('right', [0, 0, 0, 0, 1], [0, 0, 0.5, -1])
    ctx.rays[0].dispatchEvent({ type: 'connected', data: source } as any)
    const down = vi.fn()
    ctx.input.on('buttondown', down)

    ctx.input.poll()

    const right = ctx.input.right
    expect(right.isPressed(XRControllerButton.A)).toBe(true)
    expect(right.justPressed(XRControllerButton.A)).toBe(true)
    expect(ctx.input.isPressed(XRControllerButton.A)).toBe(true)
    expect(down).toHaveBeenCalledWith({ controller: right, button: XRControllerButton.A })
    expect(right.stick.y).toBeGreaterThan(0)
    expect(right.stick.x).toBeGreaterThan(0)

    // The trigger is analog and counts as pressed past the threshold
    ;(source.gamepad!.buttons as any)[0] = button(0.6)
    ctx.input.poll()
    expect(right.justPressed(XRControllerButton.A)).toBe(false)
    expect(right.isPressed(XRControllerButton.Trigger)).toBe(true)
    expect(right.value(XRControllerButton.Trigger)).toBe(0.6)
  })

  it('releases held buttons when the controller goes away', () => {
    ctx.rays[0].dispatchEvent({
      type: 'connected',
      data: inputSource('right', [1]),
    } as any)
    ctx.input.poll()
    const up = vi.fn()
    const disconnected = vi.fn()
    ctx.input.on('buttonup', up)
    ctx.input.on('disconnected', disconnected)

    ctx.rays[0].dispatchEvent({ type: 'disconnected', data: {} } as any)
    ctx.input.poll()

    expect(disconnected).toHaveBeenCalledWith(ctx.input.right)
    expect(up).toHaveBeenCalledWith({ controller: ctx.input.right, button: XRControllerButton.Trigger })
    expect(ctx.input.right.isPressed(XRControllerButton.Trigger)).toBe(false)
  })

  it('passes the session\'s select and squeeze on with the hand', () => {
    ctx.rays[0].dispatchEvent({
      type: 'connected',
      data: inputSource('left'),
    } as any)
    const select = vi.fn()
    const squeeze = vi.fn()
    ctx.input.on('selectstart', select)
    ctx.input.on('squeezeend', squeeze)

    ctx.rays[0].dispatchEvent({ type: 'selectstart' } as any)
    ctx.rays[0].dispatchEvent({ type: 'squeezeend' } as any)

    expect(select).toHaveBeenCalledWith({ controller: ctx.input.left })
    expect(squeeze).toHaveBeenCalledWith({ controller: ctx.input.left })
  })

  it('raycasts along where the controller points, in the world', () => {
    ctx.rays[0].dispatchEvent({
      type: 'connected',
      data: inputSource('right'),
    } as any)
    // The player stands 10m along X, pointing forward (-Z)
    ctx.rig.position.set(10, 0, 0)
    ctx.rays[0].position.set(0, 1, 0)

    const wall = new Mesh(new PlaneGeometry(4, 4), new MeshBasicMaterial())
    // Off center, so the ray doesn't run along the edge between its two triangles
    wall.position.set(10.3, 1.2, -5)
    wall.updateMatrixWorld()
    const elsewhere = wall.clone()
    elsewhere.position.set(0, 1, -5)
    elsewhere.updateMatrixWorld()

    const hits = ctx.input.raycast('right', new Raycaster(), [wall, elsewhere])
    expect(hits.map(hit => hit.object)).toEqual([wall])
    expect(hits[0].distance).toBeCloseTo(5)

    expect(ctx.input.raycast('left', new Raycaster(), [wall])).toEqual([])
  })

  it('vibrates through the haptic actuator', async () => {
    const source = inputSource('right')
    ctx.rays[0].dispatchEvent({ type: 'connected', data: source } as any)

    await expect(ctx.input.right.vibrate(0.5, 50)).resolves.toBe(true)
    expect((source.gamepad!.hapticActuators as any)[0].pulse).toHaveBeenCalledWith(0.5, 50)
    await expect(ctx.input.left.vibrate()).resolves.toBe(false)
  })
})
