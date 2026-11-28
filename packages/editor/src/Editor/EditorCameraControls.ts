import type { Camera } from 'three'
import { Euler, MathUtils, PerspectiveCamera, Vector3 } from 'three'

/** Something to frame with the camera: a point and how big it is around it */
export interface FocusTarget {
  center: Vector3
  radius: number
}

type DragMode = 'none' | 'look' | 'pan' | 'orbit'

const MAX_PITCH = Math.PI / 2 - 0.001
/** Pixels the pointer has to move before a press counts as a drag rather than a click */
const DRAG_THRESHOLD = 3

const FLY_KEYS: Record<string, Vector3> = {
  KeyW: new Vector3(0, 0, -1),
  KeyS: new Vector3(0, 0, 1),
  KeyA: new Vector3(-1, 0, 0),
  KeyD: new Vector3(1, 0, 0),
  KeyQ: new Vector3(0, -1, 0),
  KeyE: new Vector3(0, 1, 0),
}

function isTyping(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null
  if (!el || typeof el.tagName !== 'string')
    return false
  return el.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(el.tagName)
}

/**
 * Viewport camera controls like Unreal's editor:
 *
 * - Right drag: look around. While held, WASD flies, Q/E go down/up, Shift is faster, the wheel changes fly speed
 * - Middle drag: pan
 * - Alt + left drag: orbit around the focus target (the selection, or the point being looked at)
 * - Wheel: dolly forward/back
 * - F: frame the selection
 *
 * Left click is left alone for selecting and the transform gizmo. The camera never rolls.
 */
export default class EditorCameraControls {
  /** Off while something else uses the pointer, e.g. the transform gizmo is being dragged */
  private _enabled = true
  /** Units per second while flying */
  flySpeed = 10
  /** Radians per pixel dragged */
  lookSpeed = 0.004
  /** The point orbiting and panning work around */
  readonly target = new Vector3()

  /** True when the last press was dragged far enough to not be a click */
  dragged = false

  private readonly camera: Camera
  private readonly element: HTMLElement
  private readonly getFocus: () => FocusTarget | undefined
  private readonly abort = new AbortController()

  private yaw = 0
  private pitch = 0
  private mode: DragMode = 'none'
  private pointerId: number | null = null
  private dragDistance = 0
  private readonly keys = new Set<string>()

  constructor(camera: Camera, element: HTMLElement, getFocus: () => FocusTarget | undefined = () => undefined, keyTarget: EventTarget = window) {
    this.camera = camera
    this.element = element
    this.getFocus = getFocus
    this.syncFromCamera()
    this.target.copy(this.camera.position).addScaledVector(this.forward(), 10)

    const signal = this.abort.signal
    element.addEventListener('pointerdown', e => this.onPointerDown(e as PointerEvent), { signal })
    element.addEventListener('pointermove', e => this.onPointerMove(e as PointerEvent), { signal })
    element.addEventListener('pointerup', e => this.onPointerUp(e as PointerEvent), { signal })
    element.addEventListener('pointercancel', e => this.onPointerUp(e as PointerEvent), { signal })
    element.addEventListener('wheel', e => this.onWheel(e as WheelEvent), { signal, passive: false })
    element.addEventListener('contextmenu', e => e.preventDefault(), { signal })
    keyTarget.addEventListener('keydown', e => this.onKeyDown(e as KeyboardEvent), { signal })
    keyTarget.addEventListener('keyup', e => this.keys.delete((e as KeyboardEvent).code), { signal })
    keyTarget.addEventListener('blur', () => this.stop(), { signal })
  }

  get enabled(): boolean {
    return this._enabled
  }

  set enabled(value: boolean) {
    this._enabled = value
    if (!value)
      this.stop()
  }

  /** What the controls are doing right now */
  get dragMode(): DragMode {
    return this.mode
  }

  /** Take over the camera's current rotation, e.g. after something else moved it */
  syncFromCamera(): void {
    const euler = new Euler().setFromQuaternion(this.camera.quaternion, 'YXZ')
    this.yaw = euler.y
    this.pitch = MathUtils.clamp(euler.x, -MAX_PITCH, MAX_PITCH)
    this.applyRotation()
  }

  /** Moves the camera so `focus` fills the view, keeping the direction it looks in */
  frame(focus: FocusTarget): void {
    const fov = this.camera instanceof PerspectiveCamera
      ? MathUtils.degToRad(this.camera.fov)
      : Math.PI / 4
    const distance = Math.max(focus.radius, 0.25) / Math.sin(fov / 2) * 1.1
    this.target.copy(focus.center)
    this.camera.position.copy(focus.center).addScaledVector(this.forward(), -distance)
  }

  update(delta: number): void {
    if (this.mode !== 'look' || this.keys.size === 0)
      return

    const move = new Vector3()
    for (const code of this.keys) {
      const dir = FLY_KEYS[code]
      if (dir)
        move.add(dir)
    }
    if (move.lengthSq() === 0)
      return

    const speed = this.flySpeed * (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight')
      ? 3
      : 1)
    // Q/E move straight down/up, the rest along where the camera looks
    const vertical = move.y
    move.y = 0
    move.applyQuaternion(this.camera.quaternion)
    move.y += vertical
    move.normalize().multiplyScalar(speed * delta)
    this.camera.position.add(move)
    this.target.add(move)
  }

  dispose(): void {
    this.stop()
    this.abort.abort()
  }

  private onPointerDown(e: PointerEvent) {
    if (!this._enabled || this.mode !== 'none')
      return

    const mode: DragMode = e.button === 2
      ? 'look'
      : e.button === 1
        ? 'pan'
        : e.button === 0 && e.altKey
          ? 'orbit'
          : 'none'
    this.dragged = false
    if (mode === 'none')
      return

    e.preventDefault()
    this.syncFromCamera()
    if (mode === 'orbit') {
      const focus = this.getFocus()
      if (focus)
        this.target.copy(focus.center)
    }
    this.mode = mode
    this.pointerId = e.pointerId
    this.dragDistance = 0
    this.element.setPointerCapture?.(e.pointerId)
  }

  private onPointerMove(e: PointerEvent) {
    if (this.mode === 'none' || e.pointerId !== this.pointerId)
      return

    const dx = e.movementX
    const dy = e.movementY
    this.dragDistance += Math.abs(dx) + Math.abs(dy)
    if (this.dragDistance > DRAG_THRESHOLD)
      this.dragged = true

    if (this.mode === 'look') {
      this.rotate(dx, dy)
    }
    else if (this.mode === 'orbit') {
      const distance = Math.max(this.camera.position.distanceTo(this.target), 0.1)
      this.rotate(dx, dy)
      this.camera.position.copy(this.target).addScaledVector(this.forward(), -distance)
    }
    else if (this.mode === 'pan') {
      const scale = Math.max(this.camera.position.distanceTo(this.target), 1) * 0.0015
      const right = new Vector3(1, 0, 0).applyQuaternion(this.camera.quaternion)
      const up = new Vector3(0, 1, 0).applyQuaternion(this.camera.quaternion)
      const offset = right.multiplyScalar(-dx * scale).addScaledVector(up, dy * scale)
      this.camera.position.add(offset)
      this.target.add(offset)
    }
  }

  private onPointerUp(e: PointerEvent) {
    if (e.pointerId !== this.pointerId)
      return
    this.stop()
  }

  private onWheel(e: WheelEvent) {
    if (!this._enabled)
      return
    e.preventDefault()

    if (this.mode === 'look') {
      // Like Unreal: the wheel while flying changes how fast
      const factor = e.deltaY < 0
        ? 1.25
        : 1 / 1.25
      this.flySpeed = MathUtils.clamp(this.flySpeed * factor, 0.5, 500)
      return
    }

    // Dolly towards the target, slower the closer it is, but never stop at it
    const distance = this.camera.position.distanceTo(this.target)
    const step = -e.deltaY * Math.max(distance, 1) * 0.001
    const forward = this.forward()
    this.camera.position.addScaledVector(forward, step)
    if (step > 0 && distance - step < 0.1)
      this.target.copy(this.camera.position).addScaledVector(forward, 1)
  }

  private onKeyDown(e: KeyboardEvent) {
    if (isTyping(e.target))
      return

    if (this.mode === 'look' && e.code in FLY_KEYS)
      e.preventDefault()
    this.keys.add(e.code)

    if (e.code === 'KeyF' && this.mode === 'none' && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const focus = this.getFocus()
      if (focus)
        this.frame(focus)
    }
  }

  private rotate(dx: number, dy: number) {
    this.yaw -= dx * this.lookSpeed
    this.pitch = MathUtils.clamp(this.pitch - dy * this.lookSpeed, -MAX_PITCH, MAX_PITCH)
    this.applyRotation()
  }

  private applyRotation() {
    this.camera.quaternion.setFromEuler(new Euler(this.pitch, this.yaw, 0, 'YXZ'))
  }

  private forward(): Vector3 {
    return new Vector3(0, 0, -1).applyQuaternion(this.camera.quaternion)
  }

  private stop() {
    if (this.pointerId !== null && this.element.hasPointerCapture?.(this.pointerId))
      this.element.releasePointerCapture(this.pointerId)
    this.mode = 'none'
    this.pointerId = null
    this.keys.clear()
  }
}
