// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { traceDuration } from '../../src/Dev/bridgeProtocol'
import { recordTrace } from '../../src/Dev/trace'

/** A WebGL2 context with methods on its prototype, like the browser's */
class FakeGL {
  QUERY_RESULT_AVAILABLE = 1
  QUERY_RESULT = 2
  drawElements() {}
  drawArraysInstanced() {}
  useProgram() {}
  bindTexture() {}
  bindFramebuffer() {}
  bindVertexArray() {}
  uniform1f() {}
  uniformMatrix4fv() {}
  bufferData() {}
  bufferSubData() {}
  texImage2D() {}
  compileShader() {}
  linkProgram() {}
  getProgramParameter() {}
  readPixels() {}
  getError() {}
  getExtension() {
    return { TIME_ELAPSED_EXT: 10, GPU_DISJOINT_EXT: 11 }
  }

  createQuery() {
    return {}
  }

  beginQuery() {}
  endQuery() {}
  deleteQuery() {}
  getParameter() {
    return false
  }

  getQueryParameter(_query: unknown, name: number) {
    return name === this.QUERY_RESULT_AVAILABLE ? true : 4_000_000
  }
}

function fakeGame(gl: FakeGL) {
  const info = { autoReset: true, render: { calls: 0, triangles: 0 }, programs: [{}], reset() {
    info.render.calls = 0
    info.render.triangles = 0
  } }
  const pass = {
    render() {
      gl.useProgram()
      gl.bindTexture()
      gl.uniform1f()
      gl.uniformMatrix4fv()
      gl.drawElements()
      gl.drawArraysInstanced()
      info.render.calls += 2
      info.render.triangles += 100
    },
  }
  const perf = { begin: vi.fn(), end: vi.fn() }
  const renderer = {
    instance: { getContext: () => gl, getPixelRatio: () => 1, info },
    composer: { passes: [pass], render: () => pass.render() },
    perf: perf as typeof perf | undefined,
    maxFps: 0,
    update(this: any, _delta: number) {
      this.perf?.begin()
      this.composer.render()
    },
  }
  const world = { update: vi.fn() }
  const game = {
    canvas: { width: 800, height: 600 },
    renderer,
    world,
    physicsWorld: { step: vi.fn() },
    tick() {
      this.physicsWorld.step()
      this.world.update(0.03)
    },
  }
  return { game, renderer, info, perf }
}

describe('recordTrace', () => {
  let raf: ReturnType<typeof setInterval>
  beforeEach(() => {
    vi.useFakeTimers()
    // jsdom has no animation frames worth waiting on
    vi.stubGlobal('requestAnimationFrame', (cb: FrameRequestCallback) => setTimeout(() => cb(performance.now()), 16))
  })
  afterEach(() => {
    clearInterval(raf)
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('records frames, passes, WebGL work and ticks, then puts everything back', async () => {
    const gl = new FakeGL()
    const { game, renderer, info, perf } = fakeGame(gl)
    const originalUpdate = renderer.update
    const originalTick = game.tick

    raf = setInterval(() => {
      renderer.update(0.016)
      game.tick()
    }, 16)
    // A shader compiled and a texture uploaded between frames, both belong to the next one
    setTimeout(() => {
      gl.linkProgram()
      gl.texImage2D(0, 0, 0, 512, 256)
      gl.bufferData(0, new Float32Array(256))
      gl.readPixels()
    }, 40)

    const done = recordTrace(game as any, { durationMs: 200, gpu: true, jsProfile: true, sampleIntervalMs: 10 })
    expect(renderer.perf).toBeUndefined()
    await vi.advanceTimersByTimeAsync(400)
    const capture = await done

    expect(capture.frames.length).toBeGreaterThan(8)
    expect(capture.passes).toEqual(['Object'])
    const frame = capture.frames[3]!
    expect(frame).toMatchObject({ calls: 2, triangles: 100, gpu: 4 })
    expect(frame.interval).toBeCloseTo(16, 0)
    expect(frame.passes[0]).toHaveLength(2)
    expect(frame.gl).toMatchObject({ draws: 2, instancedDraws: 1, programSwitches: 1, textureBinds: 1, uniformCalls: 2 })

    const withUploads = capture.frames.find(f => f.gl.textureUploads)!
    expect(withUploads.gl).toMatchObject({ shaderCompiles: 1, textureUploads: 1, bufferUploads: 1, bufferUploadBytes: 1024, syncCalls: 1 })

    expect(capture.ticks.length).toBeGreaterThan(8)
    expect(game.physicsWorld.step).toHaveBeenCalled()
    expect(capture.ticks[0]).toMatchObject({ physics: expect.any(Number), world: expect.any(Number) })

    expect(capture.gpuTiming).toEqual({ enabled: true, note: expect.stringContaining('three-perf') })
    expect(capture.jsProfile).toEqual({ enabled: false, note: expect.stringContaining('Chromium') })

    // Restored
    expect(renderer.update).toBe(originalUpdate)
    expect(game.tick).toBe(originalTick)
    expect(renderer.perf).toBe(perf)
    expect(info.autoReset).toBe(true)
    expect(Object.getOwnPropertyNames(gl)).not.toContain('drawElements')
  })

  it('runs one trace at a time and skips GPU timing when asked', async () => {
    const gl = new FakeGL()
    const { game } = fakeGame(gl)

    const first = recordTrace(game as any, { durationMs: 50, gpu: false, jsProfile: false, sampleIntervalMs: 10 })
    await expect(recordTrace(game as any, { durationMs: 50, gpu: false, jsProfile: false, sampleIntervalMs: 10 })).rejects.toThrow('already running')
    await vi.advanceTimersByTimeAsync(100)
    const capture = await first

    expect(capture.gpuTiming).toEqual({ enabled: false, note: 'Turned off' })
    expect(capture.jsProfile).toEqual({ enabled: false, note: 'Turned off' })
  })

  it('keeps the duration within limits', () => {
    expect(traceDuration(undefined)).toBe(3000)
    expect(traceDuration('abc')).toBe(3000)
    expect(traceDuration('20')).toBe(100)
    expect(traceDuration(99999)).toBe(15000)
  })
})
