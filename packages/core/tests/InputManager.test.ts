// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import Game from '../src/Game'
import InputManager from '../src/InputManager'

vi.mock('../src/Game', () => ({
  default: {
    instance: vi.fn(),
  },
}))

function mockGame(rect: { left: number, top: number, width: number, height: number } | null) {
  const canvas = rect
    ? {
        getBoundingClientRect: () => rect,
      }
    : undefined
  vi.mocked(Game.instance).mockReturnValue({
    canvas,
    sizes: { width: 1000, height: 500 },
  } as any)
}

describe('input cursor', () => {
  let input: InputManager

  beforeEach(() => {
    input = new InputManager()
  })

  it('is relative to the canvas when it does not start at the window corner', () => {
    // An editor viewport: 800x400 canvas, 200px from the left and 100px from the top
    mockGame({
      left: 200,
      top: 100,
      width: 800,
      height: 400,
    })

    input.updateCursor({ clientX: 600, clientY: 300 })
    expect(input.cursor.x).toBeCloseTo(0)
    expect(input.cursor.y).toBeCloseTo(0)

    input.updateCursor({ clientX: 200, clientY: 100 })
    expect(input.cursor.x).toBeCloseTo(-1)
    expect(input.cursor.y).toBeCloseTo(1)
  })

  it('follows mouse moves and presses', () => {
    mockGame({
      left: 200,
      top: 100,
      width: 800,
      height: 400,
    })

    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 1000, clientY: 500 }))
    expect(input.cursor.x).toBeCloseTo(1)
    expect(input.cursor.y).toBeCloseTo(-1)

    const press = new MouseEvent('pointerdown', { clientX: 600, clientY: 300 })
    window.dispatchEvent(press)
    expect(input.cursor.x).toBeCloseTo(0)
  })

  it('falls back to the game size without a laid out canvas', () => {
    mockGame(null)
    input.updateCursor({ clientX: 500, clientY: 250 })
    expect(input.cursor.x).toBeCloseTo(0)
    expect(input.cursor.y).toBeCloseTo(0)
  })
})
