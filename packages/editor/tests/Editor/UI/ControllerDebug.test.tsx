// @vitest-environment jsdom

import GamepadManager from '@mavonengine/core/GamepadManager'
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import ControllerDebug from '../../../src/Editor/UI/Controllers/ControllerDebug'

vi.mock('../../../src/Editor/UI/Controllers/ControllerDebug.module.css', () => ({
  default: new Proxy({}, { get: (_, key) => String(key) }),
}))

function makePad(pressed: number[] = [], id = 'DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)') {
  return {
    index: 0,
    id,
    connected: true,
    mapping: 'standard',
    axes: [0.5, 0, 0, 0],
    buttons: Array.from({ length: 17 }, (_, i) => ({ pressed: pressed.includes(i), touched: false, value: pressed.includes(i) ? 1 : 0 })),
    vibrationActuator: { playEffect: vi.fn().mockResolvedValue('complete') },
  } as unknown as Gamepad
}

let pads: (Gamepad | null)[]
let manager: GamepadManager

beforeEach(() => {
  pads = []
  vi.stubGlobal('navigator', { getGamepads: () => pads })
  manager = new GamepadManager()
  ;(window as any).Game = { input: { gamepads: manager } }
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

describe('controllerDebug', () => {
  it('shows a hint when no controller is connected', () => {
    render(<ControllerDebug />)
    screen.getByText(/No controller detected/)
  })

  it('renders a connected controller with its type and labels', () => {
    render(<ControllerDebug />)

    act(() => {
      pads = [makePad()]
      manager.poll()
    })

    screen.getByText('playstation')
    screen.getByTitle('DualSense Wireless Controller (STANDARD GAMEPAD Vendor: 054c Product: 0ce6)')
    screen.getByText('0 Cross')
    screen.getByText('0.500')
    screen.getByText(/#0 connected/)
  })

  it('logs button presses and highlights pressed buttons', () => {
    render(<ControllerDebug />)

    act(() => {
      pads = [makePad()]
      manager.poll()
    })
    act(() => {
      pads = [makePad([1])]
      manager.poll()
    })

    screen.getByText(/#0 Circle down/)
    expect(screen.getByText('1 Circle').parentElement?.className).toContain('rowPressed')
  })

  it('triggers rumble on the controller', async () => {
    const pad = makePad()
    render(<ControllerDebug />)
    act(() => {
      pads = [pad]
      manager.poll()
    })

    await act(async () => {
      fireEvent.click(screen.getByText('Rumble'))
    })

    expect(pad.vibrationActuator!.playEffect).toHaveBeenCalledWith('dual-rumble', expect.objectContaining({ duration: 300 }))
  })
})
