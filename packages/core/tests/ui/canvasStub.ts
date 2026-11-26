import { vi } from 'vitest'

/** jsdom has no 2D canvas: a context that records what's drawn, measuring text at 20 px a character */
export function stubCanvas() {
  const drawn: string[] = []
  const ctx = {
    font: '',
    fillStyle: '',
    textAlign: '',
    textBaseline: '',
    measureText: (text: string) => ({ width: text.length * 20 }),
    clearRect: vi.fn(),
    beginPath: vi.fn(),
    roundRect: vi.fn(),
    fill: vi.fn(),
    fillRect: vi.fn(),
    fillText: vi.fn((text: string) => drawn.push(text)),
  }
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => ctx as any)
  return { ctx, drawn }
}
