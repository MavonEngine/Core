// @vitest-environment jsdom
import { Euler, PerspectiveCamera, Vector3 } from 'three'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import EditorCameraControls from '../../src/Editor/EditorCameraControls'

/** jsdom has no PointerEvent, so build mouse events with the pointer fields the controls read */
function pointer(type: string, init: { button?: number, altKey?: boolean, movementX?: number, movementY?: number } = {}) {
  const event = new MouseEvent(type, { button: init.button ?? 0, altKey: init.altKey ?? false, cancelable: true })
  Object.assign(event, { pointerId: 1 })
  Object.defineProperty(event, 'movementX', { value: init.movementX ?? 0 })
  Object.defineProperty(event, 'movementY', { value: init.movementY ?? 0 })
  return event
}

function key(type: 'keydown' | 'keyup', code: string, target: EventTarget = window) {
  target.dispatchEvent(new KeyboardEvent(type, { code, bubbles: true }))
}

function forward(camera: PerspectiveCamera) {
  return new Vector3(0, 0, -1).applyQuaternion(camera.quaternion)
}

describe('editor camera controls', () => {
  let camera: PerspectiveCamera
  let canvas: HTMLElement
  let controls: EditorCameraControls
  let focus: { center: Vector3, radius: number } | undefined

  beforeEach(() => {
    camera = new PerspectiveCamera(60)
    camera.position.set(0, 0, 10)
    canvas = document.createElement('div')
    document.body.appendChild(canvas)
    focus = undefined
    controls = new EditorCameraControls(camera, canvas, () => focus)
  })

  afterEach(() => {
    controls.dispose()
    canvas.remove()
  })

  it('looks around with a right drag, without rolling', () => {
    canvas.dispatchEvent(pointer('pointerdown', { button: 2 }))
    canvas.dispatchEvent(pointer('pointermove', { movementX: 100, movementY: 50 }))

    const euler = new Euler().setFromQuaternion(camera.quaternion, 'YXZ')
    expect(euler.y).toBeCloseTo(-0.4)
    expect(euler.x).toBeCloseTo(-0.2)
    expect(euler.z).toBeCloseTo(0)
    expect(camera.position.z).toBe(10)
    expect(controls.dragged).toBe(true)
  })

  it('does not look past straight up or down', () => {
    canvas.dispatchEvent(pointer('pointerdown', { button: 2 }))
    canvas.dispatchEvent(pointer('pointermove', { movementY: -100000 }))
    expect(forward(camera).y).toBeGreaterThan(0.99)
    expect(forward(camera).y).toBeLessThan(1)
  })

  it('flies with WASD only while the right button is held', () => {
    key('keydown', 'KeyW')
    controls.update(1)
    expect(camera.position.z).toBe(10)

    canvas.dispatchEvent(pointer('pointerdown', { button: 2 }))
    key('keydown', 'KeyW')
    controls.update(1)
    expect(camera.position.z).toBeCloseTo(0)

    key('keyup', 'KeyW')
    key('keydown', 'KeyE')
    controls.update(0.5)
    expect(camera.position.y).toBeCloseTo(5)

    canvas.dispatchEvent(pointer('pointerup', { button: 2 }))
    key('keydown', 'KeyS')
    controls.update(1)
    expect(camera.position.z).toBeCloseTo(0)
  })

  it('ignores keys typed into inputs', () => {
    const input = document.createElement('input')
    document.body.appendChild(input)
    canvas.dispatchEvent(pointer('pointerdown', { button: 2 }))
    key('keydown', 'KeyW', input)
    controls.update(1)
    expect(camera.position.z).toBe(10)
    input.remove()
  })

  it('changes fly speed with the wheel while looking, dollies otherwise', () => {
    canvas.dispatchEvent(pointer('pointerdown', { button: 2 }))
    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))
    expect(controls.flySpeed).toBeCloseTo(12.5)
    expect(camera.position.z).toBe(10)
    canvas.dispatchEvent(pointer('pointerup', { button: 2 }))

    canvas.dispatchEvent(new WheelEvent('wheel', { deltaY: -100, cancelable: true }))
    expect(camera.position.z).toBeLessThan(10)
  })

  it('pans with a middle drag', () => {
    canvas.dispatchEvent(pointer('pointerdown', { button: 1 }))
    canvas.dispatchEvent(pointer('pointermove', { movementX: 100 }))
    expect(camera.position.x).toBeLessThan(0)
    expect(camera.position.z).toBeCloseTo(10)
  })

  it('orbits the selection with alt + left drag, keeping its distance', () => {
    focus = {
      center: new Vector3(0, 0, 0),
      radius: 1,
    }
    canvas.dispatchEvent(pointer('pointerdown', { button: 0, altKey: true }))
    canvas.dispatchEvent(pointer('pointermove', { movementX: Math.PI / 2 / 0.004 }))

    expect(camera.position.length()).toBeCloseTo(10)
    // Dragging right turns the view right, like looking, so the camera swings round to the left
    expect(camera.position.x).toBeCloseTo(-10)
    // Still looking at the selection
    expect(forward(camera).dot(camera.position.clone().negate().normalize())).toBeCloseTo(1)
  })

  it('leaves a plain left click alone', () => {
    canvas.dispatchEvent(pointer('pointerdown', { button: 0 }))
    canvas.dispatchEvent(pointer('pointermove', { movementX: 100 }))
    expect(controls.dragMode).toBe('none')
    expect(camera.quaternion.equals(new PerspectiveCamera().quaternion)).toBe(true)
  })

  it('frames the selection with F', () => {
    focus = {
      center: new Vector3(50, 0, 0),
      radius: 2,
    }
    key('keydown', 'KeyF')
    expect(controls.target.equals(focus.center)).toBe(true)
    const toFocus = focus.center.clone().sub(camera.position)
    expect(toFocus.clone().normalize().dot(forward(camera))).toBeCloseTo(1)
    expect(toFocus.length()).toBeCloseTo(2 / Math.sin(Math.PI / 6) * 1.1)
  })

  it('stops dragging when disabled, e.g. by the transform gizmo', () => {
    canvas.dispatchEvent(pointer('pointerdown', { button: 2 }))
    controls.enabled = false
    expect(controls.dragMode).toBe('none')
    canvas.dispatchEvent(pointer('pointerdown', { button: 2 }))
    expect(controls.dragMode).toBe('none')
  })
})
