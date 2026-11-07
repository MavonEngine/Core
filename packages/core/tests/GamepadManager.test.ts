import { Vector2 } from 'three'
// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import GamepadManager, { applyRadialDeadzone, detectGamepadType, GamepadButton } from '../src/GamepadManager'

function makePad(overrides: Partial<{ index: number, id: string, pressed: number[], values: Record<number, number>, axes: number[] }> = {}) {
  const { index = 0, id = 'Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', pressed = [], values = {}, axes = [0, 0, 0, 0] } = overrides
  return {
    index,
    id,
    connected: true,
    mapping: 'standard',
    axes,
    buttons: Array.from({ length: 17 }, (_, i) => ({
      pressed: pressed.includes(i),
      touched: pressed.includes(i),
      value: values[i] ?? (pressed.includes(i) ? 1 : 0),
    })),
    vibrationActuator: { playEffect: vi.fn().mockResolvedValue('complete') },
  } as unknown as Gamepad
}

let pads: (Gamepad | null)[] = []

beforeEach(() => {
  pads = []
  vi.stubGlobal('navigator', { getGamepads: () => pads })
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('detectGamepadType', () => {
  it.each([
    ['Xbox Wireless Controller (STANDARD GAMEPAD Vendor: 045e Product: 0b13)', 'xbox'],
    ['045e-02ea-Microsoft X-Box One S pad', 'xbox'],
    ['DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)', 'playstation'],
    ['054c-09cc-Wireless Controller', 'playstation'],
    ['Pro Controller (STANDARD GAMEPAD Vendor: 057e Product: 2009)', 'nintendo'],
    ['8BitDo SN30 Pro (Vendor: 2dc8 Product: 6001)', 'generic'],
  ])('%s -> %s', (id, type) => {
    expect(detectGamepadType(id)).toBe(type)
  })
})

describe('applyRadialDeadzone', () => {
  it('zeroes input inside the deadzone', () => {
    expect(applyRadialDeadzone(0.1, 0.05, 0.15, new Vector2()).length()).toBe(0)
  })

  it('rescales so full deflection stays at 1', () => {
    const v = applyRadialDeadzone(1, 0, 0.15, new Vector2())
    expect(v.x).toBeCloseTo(1)
    expect(applyRadialDeadzone(0.575, 0, 0.15, new Vector2()).x).toBeCloseTo(0.5)
  })
})

describe('gamepadManager', () => {
  it('discovers controllers while polling and emits connected', () => {
    const manager = new GamepadManager()
    const connected = vi.fn()
    manager.on('connected', connected)

    pads = [makePad()]
    manager.poll()

    expect(connected).toHaveBeenCalledTimes(1)
    expect(manager.primary?.type).toBe('xbox')
  })

  it('tracks pressed, justPressed and justReleased across polls', () => {
    const manager = new GamepadManager()
    const down = vi.fn()
    const up = vi.fn()
    manager.on('buttondown', down)
    manager.on('buttonup', up)

    pads = [makePad({ pressed: [GamepadButton.A] })]
    manager.poll()
    expect(manager.isPressed(GamepadButton.Cross)).toBe(true)
    expect(manager.justPressed(GamepadButton.South)).toBe(true)
    expect(down).toHaveBeenCalledWith(expect.objectContaining({ button: 0 }))

    manager.poll()
    expect(manager.isPressed(GamepadButton.A)).toBe(true)
    expect(manager.justPressed(GamepadButton.A)).toBe(false)

    pads = [makePad()]
    manager.poll()
    expect(manager.isPressed(GamepadButton.A)).toBe(false)
    expect(manager.primary?.justReleased(GamepadButton.A)).toBe(true)
    expect(up).toHaveBeenCalledWith(expect.objectContaining({ button: 0 }))
  })

  it('treats analog triggers as pressed above the threshold', () => {
    const manager = new GamepadManager()

    pads = [makePad({ values: { [GamepadButton.RT]: 0.3 } })]
    manager.poll()
    expect(manager.primary?.value(GamepadButton.RT)).toBe(0.3)
    expect(manager.isPressed(GamepadButton.RT)).toBe(false)

    pads = [makePad({ values: { [GamepadButton.RT]: 0.8 } })]
    manager.poll()
    expect(manager.isPressed(GamepadButton.RT)).toBe(true)
  })

  it('exposes sticks with deadzone and up as positive Y', () => {
    const manager = new GamepadManager()
    pads = [makePad({ axes: [0, -1, 0, 0.1] })]
    manager.poll()

    expect(manager.primary?.leftStick.x).toBe(0)
    expect(manager.primary?.leftStick.y).toBeCloseTo(1)
    expect(manager.primary?.rightStick.length()).toBe(0)
  })

  it('emits disconnected when a controller disappears', () => {
    const manager = new GamepadManager()
    const disconnected = vi.fn()
    manager.on('disconnected', disconnected)

    pads = [makePad()]
    manager.poll()
    pads = [null]
    manager.poll()

    expect(disconnected).toHaveBeenCalledTimes(1)
    expect(manager.gamepads.size).toBe(0)
  })

  it('handles the gamepadconnected window event', () => {
    const manager = new GamepadManager()
    const event = new Event('gamepadconnected') as GamepadEvent
    Object.defineProperty(event, 'gamepad', { value: makePad({ index: 1, id: 'DualSense Wireless Controller' }) })
    window.dispatchEvent(event)

    expect(manager.get(1)?.type).toBe('playstation')
    expect(manager.get(1)?.buttonLabel(GamepadButton.South)).toBe('Cross')
  })

  it('vibrates via the live gamepad actuator', async () => {
    const manager = new GamepadManager()
    const pad = makePad()
    pads = [pad]

    await expect(manager.vibrate(0, { duration: 100 })).resolves.toBe(true)
    expect(pad.vibrationActuator!.playEffect).toHaveBeenCalledWith('dual-rumble', { duration: 100, strongMagnitude: 1, weakMagnitude: 1 })
    await expect(manager.vibrate(3)).resolves.toBe(false)
  })

  it('is a no-op when the Gamepad API is unavailable', () => {
    vi.stubGlobal('navigator', {})
    const manager = new GamepadManager()
    expect(() => manager.poll()).not.toThrow()
    expect(manager.primary).toBeUndefined()
  })
})
