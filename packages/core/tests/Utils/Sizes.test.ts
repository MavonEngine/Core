import { describe, expect, it, vi } from 'vitest'
import Sizes from '../../src/Utils/Sizes'

const resizeListeners: ((e: any) => void)[] = [];
(globalThis as any).window = {
  innerWidth: 0,
  innerHeight: 0,
  devicePixelRatio: 1,
  addEventListener: (_event: string, cb: (e: any) => void) => {
    resizeListeners.push(cb)
  },
  dispatchEvent: (event: { type: string }) => {
    if (event.type === 'resize') {
      resizeListeners.forEach(cb => cb(event))
    }
  },
}

describe('sizes', () => {
  it('updates on window resize and emits event', () => {
    const sizes = new Sizes()
    const listener = vi.fn()
    sizes.on('resize', listener)

    window.innerWidth = 400
    window.innerHeight = 300
    window.devicePixelRatio = 1.5
    window.dispatchEvent(new Event('resize'))

    expect(sizes.width).toBe(400)
    expect(sizes.height).toBe(300)
    expect(sizes.pixelRatio).toBe(1.5)
    expect(listener).toHaveBeenCalled()
  })
})
