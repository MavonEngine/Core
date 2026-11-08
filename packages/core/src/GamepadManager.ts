import { Vector2 } from 'three'
import EventEmitter from './Utils/EventEmitter'

/**
 * Button indices of the W3C "standard" gamepad mapping.
 * https://w3c.github.io/gamepad/#remapping
 *
 * Positional names (South/East/West/North) are layout agnostic,
 * Xbox and PlayStation aliases are provided for convenience.
 */
export const GamepadButton = {
  South: 0,
  East: 1,
  West: 2,
  North: 3,
  LeftBumper: 4,
  RightBumper: 5,
  LeftTrigger: 6,
  RightTrigger: 7,
  Select: 8,
  Start: 9,
  LeftStick: 10,
  RightStick: 11,
  DPadUp: 12,
  DPadDown: 13,
  DPadLeft: 14,
  DPadRight: 15,
  Home: 16,

  // Xbox
  A: 0,
  B: 1,
  X: 2,
  Y: 3,
  LB: 4,
  RB: 5,
  LT: 6,
  RT: 7,
  View: 8,
  Menu: 9,

  // PlayStation
  Cross: 0,
  Circle: 1,
  Square: 2,
  Triangle: 3,
  L1: 4,
  R1: 5,
  L2: 6,
  R2: 7,
  Share: 8,
  Options: 9,
  L3: 10,
  R3: 11,
} as const

export type GamepadButtonIndex = typeof GamepadButton[keyof typeof GamepadButton]

export type GamepadType = 'xbox' | 'playstation' | 'nintendo' | 'generic'

const BUTTON_LABELS: Record<GamepadType, string[]> = {
  xbox: ['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'View', 'Menu', 'LS', 'RS', 'D-Pad Up', 'D-Pad Down', 'D-Pad Left', 'D-Pad Right', 'Xbox'],
  playstation: ['Cross', 'Circle', 'Square', 'Triangle', 'L1', 'R1', 'L2', 'R2', 'Share', 'Options', 'L3', 'R3', 'D-Pad Up', 'D-Pad Down', 'D-Pad Left', 'D-Pad Right', 'PS'],
  // Browsers map Nintendo pads positionally, so South is labelled B
  nintendo: ['B', 'A', 'Y', 'X', 'L', 'R', 'ZL', 'ZR', '-', '+', 'LS', 'RS', 'D-Pad Up', 'D-Pad Down', 'D-Pad Left', 'D-Pad Right', 'Home'],
  generic: ['Button 1', 'Button 2', 'Button 3', 'Button 4', 'LB', 'RB', 'LT', 'RT', 'Select', 'Start', 'LS', 'RS', 'D-Pad Up', 'D-Pad Down', 'D-Pad Left', 'D-Pad Right', 'Home'],
}

const XBOX_ID = /xbox|xinput|vendor: 045e|^045e-/
const PLAYSTATION_ID = /playstation|dualshock|dualsense|vendor: 054c|^054c-/
const NINTENDO_ID = /nintendo|joy-con|pro controller|vendor: 057e|^057e-/

/**
 * Guess the controller family from the id string the browser reports.
 * Ids look like "Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)"
 * in Chromium or "045e-0b13-Xbox Wireless Controller" in Firefox.
 */
export function detectGamepadType(id: string): GamepadType {
  const lower = id.toLowerCase()

  if (XBOX_ID.test(lower)) {
    return 'xbox'
  }

  if (PLAYSTATION_ID.test(lower)) {
    return 'playstation'
  }

  if (NINTENDO_ID.test(lower)) {
    return 'nintendo'
  }

  return 'generic'
}

/**
 * Radial deadzone: ignores small stick drift and rescales the remaining
 * range so output still goes smoothly from 0 to 1.
 */
export function applyRadialDeadzone(x: number, y: number, deadzone: number, target: Vector2): Vector2 {
  const magnitude = Math.hypot(x, y)

  if (magnitude <= deadzone) {
    return target.set(0, 0)
  }

  const scaled = Math.min(1, (magnitude - deadzone) / (1 - deadzone))
  return target.set(x / magnitude * scaled, y / magnitude * scaled)
}

export interface GamepadButtonEvent {
  gamepad: GamepadState
  button: number
}

export interface RumbleOptions {
  /** Duration in milliseconds */
  duration?: number
  /** Low-frequency (left) motor, 0 - 1 */
  strongMagnitude?: number
  /** High-frequency (right) motor, 0 - 1 */
  weakMagnitude?: number
}

/**
 * Snapshot of a single controller, refreshed every poll.
 */
export class GamepadState {
  readonly index: number
  readonly id: string
  readonly type: GamepadType
  readonly mapping: GamepadMappingType

  /** Analog value per button, 0 - 1 (triggers are analog, most others 0 or 1) */
  buttonValues: number[] = []
  pressed: boolean[] = []
  private previousPressed: boolean[] = []

  /** Raw axes as reported by the browser */
  axes: number[] = []

  /** Left stick after deadzone. Y is positive when pushed up. */
  readonly leftStick = new Vector2()
  /** Right stick after deadzone. Y is positive when pushed up. */
  readonly rightStick = new Vector2()

  constructor(gamepad: Gamepad) {
    this.index = gamepad.index
    this.id = gamepad.id
    this.type = detectGamepadType(gamepad.id)
    this.mapping = gamepad.mapping
  }

  /**
   * Copy the latest values from the browser gamepad.
   * Returns the buttons that changed state since the last update.
   */
  update(gamepad: Gamepad, stickDeadzone: number, buttonThreshold: number) {
    this.previousPressed = this.pressed
    this.pressed = []
    this.buttonValues = []

    const changedDown: number[] = []
    const changedUp: number[] = []

    gamepad.buttons.forEach((button, i) => {
      const isPressed = button.pressed || button.value > buttonThreshold
      this.buttonValues[i] = button.value
      this.pressed[i] = isPressed

      const wasPressed = this.previousPressed[i] ?? false
      if (isPressed && !wasPressed) {
        changedDown.push(i)
      }
      else if (!isPressed && wasPressed) {
        changedUp.push(i)
      }
    })

    this.axes = Array.from(gamepad.axes)

    // Browsers report Y as positive downward, flip it so up is positive
    applyRadialDeadzone(this.axes[0] ?? 0, -(this.axes[1] ?? 0), stickDeadzone, this.leftStick)
    applyRadialDeadzone(this.axes[2] ?? 0, -(this.axes[3] ?? 0), stickDeadzone, this.rightStick)

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

  /** Analog value of a button, 0 - 1. Useful for triggers. */
  value(button: number) {
    return this.buttonValues[button] ?? 0
  }

  /** Human readable label matching the controller family, e.g. "Cross" or "A" */
  buttonLabel(button: number) {
    return BUTTON_LABELS[this.type][button] ?? `Button ${button + 1}`
  }
}

/**
 * Polls the browser Gamepad API and exposes the state of every connected controller.
 *
 * Note: browsers only expose a gamepad after the player presses a button on it
 * while the page has focus.
 *
 * Events:
 * - `connected` (GamepadState)
 * - `disconnected` (GamepadState)
 * - `buttondown` (GamepadButtonEvent)
 * - `buttonup` (GamepadButtonEvent)
 */
export default class GamepadManager extends EventEmitter {
  readonly gamepads: Map<number, GamepadState> = new Map()

  /** Stick input below this magnitude is ignored */
  stickDeadzone = 0.15
  /** Analog buttons (triggers) count as pressed above this value */
  buttonThreshold = 0.5

  private readonly supported: boolean

  constructor() {
    super()

    this.supported = typeof navigator !== 'undefined' && typeof navigator.getGamepads === 'function'

    if (!this.supported) {
      return
    }

    window.addEventListener('gamepadconnected', (ev) => {
      this.connect(ev.gamepad)
    })

    window.addEventListener('gamepaddisconnected', (ev) => {
      this.disconnect(ev.gamepad.index)
    })
  }

  /**
   * Read the latest controller state. Called once per game update by InputManager.
   * Chromium only refreshes gamepad data through getGamepads(), so this must be polled.
   */
  poll() {
    if (!this.supported) {
      return
    }

    const seen = new Set<number>()

    for (const gamepad of navigator.getGamepads()) {
      if (!gamepad || !gamepad.connected) {
        continue
      }

      seen.add(gamepad.index)

      const state = this.connect(gamepad)
      const { changedDown, changedUp } = state.update(gamepad, this.stickDeadzone, this.buttonThreshold)

      changedDown.forEach(button => this.trigger('buttondown', { gamepad: state, button } satisfies GamepadButtonEvent))
      changedUp.forEach(button => this.trigger('buttonup', { gamepad: state, button } satisfies GamepadButtonEvent))
    }

    // Some browsers drop controllers without firing gamepaddisconnected
    for (const index of [...this.gamepads.keys()]) {
      if (!seen.has(index)) {
        this.disconnect(index)
      }
    }
  }

  /** First connected controller, handy for single player games */
  get primary(): GamepadState | undefined {
    return this.gamepads.values().next().value
  }

  get(index: number) {
    return this.gamepads.get(index)
  }

  /** Button held on any connected controller */
  isPressed(button: number) {
    for (const state of this.gamepads.values()) {
      if (state.isPressed(button)) {
        return true
      }
    }
    return false
  }

  /** Button went down this update on any connected controller */
  justPressed(button: number) {
    for (const state of this.gamepads.values()) {
      if (state.justPressed(button)) {
        return true
      }
    }
    return false
  }

  /**
   * Rumble a controller. Resolves to false when the controller or browser
   * does not support vibration.
   */
  async vibrate(index: number, { duration = 200, strongMagnitude = 1, weakMagnitude = 1 }: RumbleOptions = {}): Promise<boolean> {
    if (!this.supported) {
      return false
    }

    // Always fetch the live object, Chromium hands out snapshots
    const actuator = navigator.getGamepads()[index]?.vibrationActuator
    if (!actuator || typeof actuator.playEffect !== 'function') {
      return false
    }

    try {
      await actuator.playEffect('dual-rumble', { duration, strongMagnitude, weakMagnitude })
      return true
    }
    catch {
      return false
    }
  }

  private connect(gamepad: Gamepad) {
    let state = this.gamepads.get(gamepad.index)

    // A different controller can take over a freed slot
    if (state && state.id !== gamepad.id) {
      this.disconnect(gamepad.index)
      state = undefined
    }

    if (!state) {
      state = new GamepadState(gamepad)
      this.gamepads.set(gamepad.index, state)
      this.trigger('connected', state)
    }

    return state
  }

  private disconnect(index: number) {
    const state = this.gamepads.get(index)
    if (!state) {
      return
    }

    this.gamepads.delete(index)
    this.trigger('disconnected', state)
  }
}
