import { describe, expect, it } from 'vitest'
import FrameLimiter from '../../src/Utils/FrameLimiter'

/** Feed the limiter frames at the given refresh rate for one second and count the rendered ones */
function renderedInOneSecond(limiter: FrameLimiter, refreshRate: number) {
  let rendered = 0
  for (let frame = 1; frame <= refreshRate; frame++) {
    if (limiter.shouldRender(frame * (1000 / refreshRate)))
      rendered++
  }
  return rendered
}

describe('frameLimiter', () => {
  it('renders every frame without a cap', () => {
    expect(renderedInOneSecond(new FrameLimiter(), 144)).toBe(144)
    expect(renderedInOneSecond(new FrameLimiter(0), 240)).toBe(240)
  })

  it('caps the frames to maxFps', () => {
    expect(renderedInOneSecond(new FrameLimiter(60), 240)).toBe(60)
    expect(renderedInOneSecond(new FrameLimiter(30), 144)).toBe(30)
  })

  it('keeps close to a cap that is not a divisor of the refresh rate', () => {
    expect(renderedInOneSecond(new FrameLimiter(100), 144)).toBeGreaterThanOrEqual(99)
    expect(renderedInOneSecond(new FrameLimiter(100), 144)).toBeLessThanOrEqual(101)
  })

  it('does not drop frames when the cap matches a jittery refresh rate', () => {
    const limiter = new FrameLimiter(60)
    let now = 0
    let rendered = 0
    for (let frame = 0; frame < 60; frame++) {
      now += 1000 / 60 + (frame % 2 === 0 ? -0.4 : 0.4)
      if (limiter.shouldRender(now))
        rendered++
    }
    expect(rendered).toBe(60)
  })

  it('applies a changed cap', () => {
    const limiter = new FrameLimiter(60)
    renderedInOneSecond(limiter, 240)
    limiter.maxFps = 0
    expect(limiter.shouldRender(1001)).toBe(true)
    expect(limiter.shouldRender(1002)).toBe(true)
  })
})
