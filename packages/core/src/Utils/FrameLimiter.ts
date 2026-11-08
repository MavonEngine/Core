/**
 * How early a frame may arrive and still count, in ms. Display refresh timestamps jitter,
 * so without slack a cap equal to the refresh rate would drop every other frame.
 */
const TOLERANCE_MS = 1

/**
 * Decides which animation frames to render so the rendering stays at or below `maxFps`.
 * Only throttles rendering: the game tick and physics run on their own interval.
 */
export default class FrameLimiter {
  /** The most frames to render per second. 0 (or less) renders every frame */
  maxFps: number

  private lastFrame?: number

  constructor(maxFps = 0) {
    this.maxFps = maxFps
  }

  /**
   * @param now the frame's timestamp in ms, e.g. the one `requestAnimationFrame` passes
   * @returns whether to render this frame
   */
  shouldRender(now: number): boolean {
    if (!(this.maxFps > 0) || this.lastFrame === undefined) {
      this.lastFrame = now
      return true
    }

    const interval = 1000 / this.maxFps
    const elapsed = now - this.lastFrame
    if (elapsed < interval - TOLERANCE_MS)
      return false

    // Advance by a whole interval so the cadence doesn't drift below the cap when frames land between intervals,
    // but start over after a stall (e.g. a hidden tab) instead of trying to catch up
    this.lastFrame = elapsed > interval * 2 ? now : this.lastFrame + interval
    return true
  }
}
