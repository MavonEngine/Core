import type { Intersection, Object3D, Raycaster, WebXRManager, XRGripSpace, XRTargetRaySpace } from 'three'
import { BufferGeometry, Line, LineBasicMaterial, Matrix4, Vector2, Vector3 } from 'three'
import { XRControllerModelFactory } from 'three/examples/jsm/webxr/XRControllerModelFactory.js'
import { applyRadialDeadzone } from './GamepadManager'
import EventEmitter from './Utils/EventEmitter'

/**
 * Button indices of the WebXR "xr-standard" gamepad mapping, which Quest, Index, Vive, Pico and
 * Windows Mixed Reality controllers follow. https://www.w3.org/TR/webxr-gamepads-module-1/#xr-standard-gamepad-mapping
 */
export const XRControllerButton = {
  Trigger: 0,
  Squeeze: 1,
  Touchpad: 2,
  Thumbstick: 3,
  /** A on the right controller, X on the left */
  Primary: 4,
  /** B on the right controller, Y on the left */
  Secondary: 5,

  A: 4,
  B: 5,
  X: 4,
  Y: 5,
} as const

export type XRHand = 'left' | 'right'

export interface XRButtonEvent {
  controller: XRController
  button: number
}

/** A `select` / `squeeze` event of the session, e.g. a trigger pull or a hand-tracking pinch */
export interface XRActionEvent {
  controller: XRController
}

export interface XRInputOptions {
  /** Show the controllers' 3D models, loaded from the WebXR input profiles. Default true */
  controllerModels?: boolean
  /** Where the controller models load from. Defaults to the jsdelivr CDN, set it to self-host them */
  controllerModelsPath?: string
  /** Show a pointer line out of each controller. Default true */
  rays?: boolean
  /** How far the pointer lines reach, in meters. Default 5 */
  rayLength?: number
}

const tempMatrix = new Matrix4()

/**
 * One hand's controller, refreshed every poll. Its `ray` (where it points) and `grip` (where it's held)
 * are children of the camera rig, so they move with the player.
 */
export class XRController {
  /** The session's input source, while this hand has a controller (or tracked hand) */
  inputSource?: XRInputSource

  /** Analog value per button, 0 - 1 */
  buttonValues: number[] = []
  pressed: boolean[] = []
  private previousPressed: boolean[] = []

  /** Raw axes as reported by the browser */
  axes: number[] = []

  /** Thumbstick after deadzone. Y is positive when pushed forward. */
  readonly stick = new Vector2()

  constructor(
    readonly hand: XRHand,
    /** Follows where the controller points: -Z is forward. Swapped when the session moves this hand to another slot */
    public ray: XRTargetRaySpace,
    /** Follows where the controller is held, to attach models or held items to */
    public grip: XRGripSpace,
  ) {}

  get connected(): boolean {
    return !!this.inputSource
  }

  /** @returns the buttons that changed state since the last update */
  update(stickDeadzone: number, buttonThreshold: number) {
    this.previousPressed = this.pressed
    this.pressed = []
    this.buttonValues = []

    const changedDown: number[] = []
    const changedUp: number[] = []

    const gamepad = this.inputSource?.gamepad
    gamepad?.buttons.forEach((button, i) => {
      const isPressed = button.pressed || button.value > buttonThreshold
      this.buttonValues[i] = button.value
      this.pressed[i] = isPressed

      const wasPressed = this.previousPressed[i] ?? false
      if (isPressed && !wasPressed)
        changedDown.push(i)
      else if (!isPressed && wasPressed)
        changedUp.push(i)
    })
    // Everything held is let go when the controller goes away
    this.previousPressed.forEach((wasPressed, i) => {
      if (wasPressed && !gamepad?.buttons[i])
        changedUp.push(i)
    })

    this.axes = gamepad
      ? Array.from(gamepad.axes)
      : []
    // xr-standard puts the thumbstick on axes 2 and 3, with Y positive when pulled back
    applyRadialDeadzone(this.axes[2] ?? 0, -(this.axes[3] ?? 0), stickDeadzone, this.stick)

    return { changedDown, changedUp }
  }

  /** Button is currently held */
  isPressed(button: number) {
    return this.pressed[button] ?? false
  }

  /** Button went down since the previous update */
  justPressed(button: number) {
    return (this.pressed[button] ?? false) && !(this.previousPressed[button] ?? false)
  }

  /** Button was released since the previous update */
  justReleased(button: number) {
    return !(this.pressed[button] ?? false) && (this.previousPressed[button] ?? false)
  }

  /** Analog value of a button, 0 - 1. Useful for the trigger and squeeze. */
  value(button: number) {
    return this.buttonValues[button] ?? 0
  }

  /** Aim the raycaster along where the controller points */
  setRaycaster(raycaster: Raycaster) {
    this.ray.updateWorldMatrix(true, false)
    tempMatrix.identity().extractRotation(this.ray.matrixWorld)
    raycaster.ray.origin.setFromMatrixPosition(this.ray.matrixWorld)
    raycaster.ray.direction.set(0, 0, -1).applyMatrix4(tempMatrix)
    return raycaster
  }

  /** The world position the controller points from */
  getWorldPosition(target = new Vector3()) {
    this.ray.updateWorldMatrix(true, false)
    return target.setFromMatrixPosition(this.ray.matrixWorld)
  }

  /**
   * Vibrate the controller
   * @param intensity 0 - 1
   * @param duration in milliseconds
   * @returns whether the controller can vibrate
   */
  async vibrate(intensity = 1, duration = 100): Promise<boolean> {
    const actuator = this.inputSource?.gamepad?.hapticActuators?.[0] as { pulse?(value: number, duration: number): Promise<boolean> } | undefined
    if (!actuator?.pulse)
      return false

    try {
      await actuator.pulse(intensity, duration)
      return true
    }
    catch {
      return false
    }
  }
}

/**
 * The VR controllers, created by `Game.enableXR()` as `game.input.xr`. Polled with the other input every game update.
 *
 * Events:
 * - `connected` / `disconnected` (XRController)
 * - `buttondown` / `buttonup` (XRButtonEvent)
 * - `selectstart` / `selectend` / `select` (XRActionEvent): the primary action, the trigger or a hand pinch
 * - `squeezestart` / `squeezeend` / `squeeze` (XRActionEvent)
 */
export default class XRInput extends EventEmitter {
  readonly left: XRController
  readonly right: XRController

  /** Thumbstick input below this magnitude is ignored */
  stickDeadzone = 0.15
  /** Analog buttons count as pressed above this value */
  buttonThreshold = 0.5

  /** The controllers by the slot three.js gives them, which isn't tied to a hand */
  private readonly slots: { ray: XRTargetRaySpace, grip: XRGripSpace, controller?: XRController }[] = []

  constructor(xr: WebXRManager, rig: Object3D, options: XRInputOptions = {}) {
    super()

    const modelFactory = options.controllerModels === false
      ? undefined
      : new XRControllerModelFactory()
    if (modelFactory && options.controllerModelsPath)
      modelFactory.setPath(options.controllerModelsPath)

    for (let i = 0; i < 2; i++) {
      const ray = xr.getController(i)
      const grip = xr.getControllerGrip(i)
      rig.add(ray, grip)
      if (modelFactory)
        grip.add(modelFactory.createControllerModel(grip))
      if (options.rays !== false)
        ray.add(createRayLine(options.rayLength ?? 5))

      this.slots.push({ ray, grip })
    }

    // The hands get their own objects so games can hold on to `left` / `right`; they take on whichever slot's
    // ray and grip the session puts that hand in
    this.left = new XRController('left', this.slots[0].ray, this.slots[0].grip)
    this.right = new XRController('right', this.slots[1].ray, this.slots[1].grip)

    this.slots.forEach((slot) => {
      slot.ray.addEventListener('connected', event => this.connect(slot, event.data))
      slot.ray.addEventListener('disconnected', () => this.disconnect(slot))

      for (const type of [
        'selectstart',
        'selectend',
        'select',
        'squeezestart',
        'squeezeend',
        'squeeze',
      ] as const) {
        slot.ray.addEventListener(type, () => {
          if (slot.controller)
            this.trigger(type, { controller: slot.controller } satisfies XRActionEvent)
        })
      }
    })
  }

  get controllers(): XRController[] {
    return [this.left, this.right]
  }

  /** Read the latest controller state. Called once per game update by InputManager. */
  poll() {
    for (const controller of this.controllers) {
      const { changedDown, changedUp } = controller.update(this.stickDeadzone, this.buttonThreshold)
      changedDown.forEach(button => this.trigger('buttondown', { controller, button } satisfies XRButtonEvent))
      changedUp.forEach(button => this.trigger('buttonup', { controller, button } satisfies XRButtonEvent))
    }
  }

  /** Button is held on either controller */
  isPressed(button: number) {
    return this.left.isPressed(button) || this.right.isPressed(button)
  }

  /** Button went down on either controller since the previous update */
  justPressed(button: number) {
    return this.left.justPressed(button) || this.right.justPressed(button)
  }

  /**
   * What a controller points at, nearest first. Nothing while that hand has no controller.
   */
  raycast(hand: XRHand, raycaster: Raycaster, objects: Object3D[], recursive = true): Intersection[] {
    const controller = this[hand]
    if (!controller.connected)
      return []

    return controller.setRaycaster(raycaster).intersectObjects(objects, recursive)
  }

  private connect(slot: typeof this.slots[number], inputSource: XRInputSource) {
    // Gaze and screen input (e.g. a phone) has no hand to put it on
    if (inputSource.handedness !== 'left' && inputSource.handedness !== 'right')
      return

    const controller = this[inputSource.handedness]
    controller.ray = slot.ray
    controller.grip = slot.grip
    controller.inputSource = inputSource
    slot.controller = controller
    this.trigger('connected', controller)
  }

  private disconnect(slot: typeof this.slots[number]) {
    const controller = slot.controller
    if (!controller)
      return

    slot.controller = undefined
    controller.inputSource = undefined
    this.trigger('disconnected', controller)
  }
}

function createRayLine(length: number) {
  const geometry = new BufferGeometry().setFromPoints([
    new Vector3(0, 0, 0),
    new Vector3(0, 0, -1),
  ])
  const line = new Line(geometry, new LineBasicMaterial({ color: 0xFFFFFF, transparent: true, opacity: 0.6 }))
  line.name = 'XRControllerRay'
  line.scale.z = length
  return line
}
