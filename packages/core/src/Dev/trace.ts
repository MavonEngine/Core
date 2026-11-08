import type Game from '../Game'

/**
 * Records a few seconds of a game tab for the dev bridge `trace` query: every rendered frame (CPU time, GPU time, the
 * composer passes, the WebGL calls it made), game ticks, slow WebGL calls (shader compiles, uploads, GPU syncs),
 * long animation frames, `performance.measure()` spans and, where the browser has it, a JS sampling profile.
 * Everything it patches is put back when it ends. Only used in dev, through the bridge.
 */

export interface TraceOptions {
  durationMs: number
  /** Time each frame on the GPU with EXT_disjoint_timer_query_webgl2 */
  gpu: boolean
  /** Sample JS stacks with the JS Self-Profiling API (Chromium, needs `Document-Policy: js-profiling`) */
  jsProfile: boolean
  sampleIntervalMs: number
}

/** WebGL work of one frame, counted on the context */
export interface GlCounts {
  /** drawArrays / drawElements and their instanced and range variants */
  draws: number
  instancedDraws: number
  programSwitches: number
  textureBinds: number
  framebufferBinds: number
  vertexArrayBinds: number
  uniformCalls: number
  bufferUploads: number
  bufferUploadBytes: number
  textureUploads: number
  textureUploadMs: number
  shaderCompiles: number
  /** compileShader, linkProgram and the status checks, where the browser actually waits for the driver */
  shaderCompileMs: number
  /** readPixels, getError, finish, clientWaitSync, getBufferSubData: calls that wait for the GPU */
  syncCalls: number
  syncMs: number
}

export interface TraceFrame {
  /** ms since the trace started, when the frame began rendering */
  start: number
  /** ms since the previous frame began, null for the first */
  interval: number | null
  /** ms on the CPU in Renderer.update (the composer and its passes) */
  cpu: number
  /** ms on the GPU, null when not measured */
  gpu: number | null
  /** [start, duration] of each composer pass, in the order of `passes`, null for passes that didn't render */
  passes: ([number, number] | null)[]
  /** three.js renderer.info for the frame */
  calls: number
  triangles: number
  gl: GlCounts
  /** usedJSHeapSize after the frame, null outside Chromium */
  heap: number | null
}

export interface TraceTick {
  start: number
  duration: number
  physics: number | null
  world: number | null
}

export interface TraceSpan {
  /** e.g. linkProgram, texImage2D 2048x2048, a measure name, long animation frame */
  name: string
  category: 'gl' | 'measure' | 'long-animation-frame' | 'long-task' | 'script'
  start: number
  duration: number
  detail?: Record<string, unknown>
}

/** The JS Self-Profiling API's trace, timestamps made relative to the trace start */
export interface TraceProfile {
  sampleIntervalMs: number
  resources: string[]
  frames: { name: string, resourceId?: number, line?: number, column?: number }[]
  stacks: { frameId: number, parentId?: number }[]
  samples: { timestamp: number, stackId?: number }[]
}

export interface TraceCapture {
  /** Epoch ms when it started */
  startedAt: number
  durationMs: number
  userAgent: string
  visible: boolean
  canvas: { width: number, height: number, pixelRatio: number }
  /** Composer pass names, the order of TraceFrame.passes */
  passes: string[]
  gpuTiming: { enabled: boolean, note?: string }
  jsProfile: { enabled: boolean, note?: string }
  programs: number
  frames: TraceFrame[]
  ticks: TraceTick[]
  spans: TraceSpan[]
  profile: TraceProfile | null
}

/** Slow single WebGL calls are kept as spans, faster ones are only counted */
const SLOW_GL_CALL_MS = 0.5
const MAX_SPANS = 2000
const MAX_FRAMES = 4000

const DRAWS = ['drawArrays', 'drawElements', 'drawRangeElements']
const INSTANCED_DRAWS = ['drawArraysInstanced', 'drawElementsInstanced']
const TEXTURE_UPLOADS = ['texImage2D', 'texSubImage2D', 'texImage3D', 'texSubImage3D', 'compressedTexImage2D', 'compressedTexSubImage2D', 'compressedTexImage3D', 'compressedTexSubImage3D', 'copyTexImage2D', 'copyTexSubImage2D', 'generateMipmap']
const SHADER = ['compileShader', 'linkProgram', 'getShaderParameter', 'getProgramParameter', 'getShaderInfoLog', 'getProgramInfoLog']
const SYNC = ['readPixels', 'getError', 'finish', 'clientWaitSync', 'getBufferSubData']

function emptyCounts(): GlCounts {
  return {
    draws: 0,
    instancedDraws: 0,
    programSwitches: 0,
    textureBinds: 0,
    framebufferBinds: 0,
    vertexArrayBinds: 0,
    uniformCalls: 0,
    bufferUploads: 0,
    bufferUploadBytes: 0,
    textureUploads: 0,
    textureUploadMs: 0,
    shaderCompiles: 0,
    shaderCompileMs: 0,
    syncCalls: 0,
    syncMs: 0,
  }
}

interface ProfilerLike {
  stop(): Promise<{ resources: string[], frames: TraceProfile['frames'], stacks: TraceProfile['stacks'], samples: TraceProfile['samples'] }>
}
type ProfilerCtor = new (options: { sampleInterval: number, maxBufferSize: number }) => ProfilerLike

let running = false

const round = (ms: number) => Math.round(ms * 1000) / 1000

function byteLength(value: unknown): number {
  if (typeof value === 'number')
    return value
  if (value && typeof value === 'object' && 'byteLength' in value)
    return Number((value as { byteLength: number }).byteLength) || 0
  return 0
}

/** e.g. `texImage2D 1024x1024` when the call has a size, otherwise the method name */
function describeUpload(method: string, args: unknown[]): string {
  const numbers = args.filter(a => typeof a === 'number') as number[]
  // texImage2D(target, level, internalformat, width, height, ...), the image overload has no size
  if (method.startsWith('texImage2D') || method.startsWith('compressedTexImage2D')) {
    const source = args[5] as { width?: number, height?: number, videoWidth?: number } | undefined
    if (numbers.length >= 5)
      return `${method} ${numbers[3]}x${numbers[4]}`
    if (source && typeof source === 'object' && (source.width || source.videoWidth))
      return `${method} ${source.videoWidth ?? source.width}x${(source as { videoHeight?: number }).videoHeight ?? source.height}`
  }
  return method
}

/**
 * Record `options.durationMs` of the game. Only one trace runs at a time
 */
export async function recordTrace(game: Game, options: TraceOptions): Promise<TraceCapture> {
  if (running)
    throw new Error('A trace is already running in this tab')
  running = true

  const restore: (() => void)[] = []
  /** Replace `target[key]` until the trace ends */
  const patch = <T extends object>(target: T, key: string, make: (original: (...args: any[]) => any) => (...args: any[]) => any) => {
    const record = target as Record<string, any>
    const original = record[key]
    if (typeof original !== 'function')
      return
    // eslint-disable-next-line e18e/prefer-object-has-own -- core targets a lib without Object.hasOwn
    const own = Object.prototype.hasOwnProperty.call(target, key)
    record[key] = make(original.bind(target))
    restore.push(() => {
      if (own)
        record[key] = original
      else
        delete record[key]
    })
  }

  try {
    const renderer = game.renderer
    const three = renderer.instance
    const gl = three.getContext() as WebGL2RenderingContext
    const t0 = performance.now()
    const now = () => performance.now() - t0

    const capture: TraceCapture = {
      startedAt: Date.now(),
      durationMs: options.durationMs,
      userAgent: navigator.userAgent,
      visible: document.visibilityState === 'visible',
      canvas: { width: game.canvas.width, height: game.canvas.height, pixelRatio: three.getPixelRatio() },
      passes: renderer.composer.passes.map(pass => pass.constructor.name || 'Pass'),
      gpuTiming: { enabled: false },
      jsProfile: { enabled: false },
      programs: three.info.programs?.length ?? 0,
      frames: [],
      ticks: [],
      spans: [],
      profile: null,
    }

    const span = (entry: TraceSpan) => {
      if (capture.spans.length < MAX_SPANS)
        capture.spans.push(entry)
    }

    // ---- WebGL calls, counted into the frame being rendered (calls between frames go to the next one)
    let counts = emptyCounts()

    const timed = (method: string, after: (ms: number, args: unknown[]) => void) => patch(gl, method, original => (...args: unknown[]) => {
      const start = performance.now()
      const result = original(...args)
      const ms = performance.now() - start
      after(ms, args)
      if (ms >= SLOW_GL_CALL_MS)
        span({ name: describeUpload(method, args), category: 'gl', start: round(start - t0), duration: round(ms) })
      return result
    })
    const counted = (method: string, count: (args: unknown[]) => void) => patch(gl, method, original => (...args: unknown[]) => {
      count(args)
      return original(...args)
    })

    DRAWS.forEach(m => counted(m, () => counts.draws++))
    INSTANCED_DRAWS.forEach(m => counted(m, () => {
      counts.draws++
      counts.instancedDraws++
    }))
    counted('useProgram', () => counts.programSwitches++)
    counted('bindTexture', () => counts.textureBinds++)
    counted('bindFramebuffer', () => counts.framebufferBinds++)
    counted('bindVertexArray', () => counts.vertexArrayBinds++)
    for (const key of Object.getOwnPropertyNames(Object.getPrototypeOf(gl) as object)) {
      if (key.startsWith('uniform') && key !== 'uniformBlockBinding')
        counted(key, () => counts.uniformCalls++)
    }
    for (const method of ['bufferData', 'bufferSubData']) {
      timed(method, (_ms, args) => {
        counts.bufferUploads++
        counts.bufferUploadBytes += byteLength(args[method === 'bufferData' ? 1 : 2])
      })
    }
    TEXTURE_UPLOADS.forEach(m => timed(m, (ms) => {
      counts.textureUploads++
      counts.textureUploadMs += ms
    }))
    SHADER.forEach(m => timed(m, (ms) => {
      if (m === 'linkProgram')
        counts.shaderCompiles++
      counts.shaderCompileMs += ms
    }))
    SYNC.forEach(m => timed(m, (ms) => {
      counts.syncCalls++
      counts.syncMs += ms
    }))

    // ---- GPU time per frame. three-perf times frames with the same extension and only one query can run at a time
    const timer = options.gpu ? gl.getExtension('EXT_disjoint_timer_query_webgl2') as { TIME_ELAPSED_EXT: number, GPU_DISJOINT_EXT: number } | null : null
    const pendingQueries: { query: WebGLQuery, frame: TraceFrame }[] = []
    if (!options.gpu) {
      capture.gpuTiming.note = 'Turned off'
    }
    else if (!timer) {
      capture.gpuTiming.note = 'The browser has no EXT_disjoint_timer_query_webgl2 (Firefox and Safari, or Chrome with it blocked on this GPU)'
    }
    else {
      capture.gpuTiming.enabled = true
      if (renderer.perf) {
        const perf = renderer.perf
        renderer.perf = undefined
        restore.push(() => {
          renderer.perf = perf
        })
        capture.gpuTiming.note = 'The three-perf panel was paused while tracing, it times the GPU with the same extension'
      }
    }

    const collectQueries = () => {
      if (!timer || !pendingQueries.length)
        return
      // A disjoint event (e.g. the GPU clocked down) makes the results in flight meaningless
      const disjoint = gl.getParameter(timer.GPU_DISJOINT_EXT) as boolean
      while (pendingQueries.length) {
        const { query, frame } = pendingQueries[0]!
        if (!disjoint && !gl.getQueryParameter(query, gl.QUERY_RESULT_AVAILABLE))
          break
        if (!disjoint)
          frame.gpu = round(Number(gl.getQueryParameter(query, gl.QUERY_RESULT)) / 1e6)
        gl.deleteQuery(query)
        pendingQueries.shift()
      }
    }

    // ---- Frames: Renderer.update runs once per requestAnimationFrame
    const info = three.info
    const autoReset = info.autoReset
    info.autoReset = false
    restore.push(() => {
      info.autoReset = autoReset
    })

    let passTimes: ([number, number] | null)[] = []
    renderer.composer.passes.forEach((pass, index) => patch(pass, 'render', original => (...args: unknown[]) => {
      const start = performance.now()
      const result = original(...args)
      passTimes[index] = [round(start - t0), round(performance.now() - start)]
      return result
    }))

    let lastStart: number | null = null
    let recording = true
    patch(renderer, 'update', original => (delta: number) => {
      if (!recording || capture.frames.length >= MAX_FRAMES)
        return original(delta)

      collectQueries()
      const start = now()
      // Calls since the previous frame (loading, game logic) belong to this one
      const frameCounts = counts
      info.reset()
      passTimes = renderer.composer.passes.map(() => null)

      const query = timer && gl.createQuery()
      if (query)
        gl.beginQuery(timer!.TIME_ELAPSED_EXT, query)
      try {
        return original(delta)
      }
      finally {
        if (query)
          gl.endQuery(timer!.TIME_ELAPSED_EXT)
        counts = emptyCounts()

        const heap = (performance as { memory?: { usedJSHeapSize: number } }).memory?.usedJSHeapSize ?? null
        const frame: TraceFrame = {
          start: round(start),
          interval: lastStart === null ? null : round(start - lastStart),
          cpu: round(now() - start),
          gpu: null,
          passes: passTimes,
          calls: info.render.calls,
          triangles: info.render.triangles,
          gl: { ...frameCounts, textureUploadMs: round(frameCounts.textureUploadMs), shaderCompileMs: round(frameCounts.shaderCompileMs), syncMs: round(frameCounts.syncMs) },
          heap,
        }
        lastStart = start
        capture.frames.push(frame)
        if (query)
          pendingQueries.push({ query, frame })
      }
    })

    // ---- Game ticks (setInterval at tickRate), with physics and the world update
    let tickParts: { physics: number | null, world: number | null } = { physics: null, world: null }
    const physicsWorld = game.physicsWorld as unknown as object | undefined
    if (physicsWorld) {
      patch(physicsWorld, 'step', original => (...args: unknown[]) => {
        const start = performance.now()
        try {
          return original(...args)
        }
        finally {
          tickParts.physics = round(performance.now() - start)
        }
      })
    }
    patch(game.world, 'update', original => (...args: unknown[]) => {
      const start = performance.now()
      try {
        return original(...args)
      }
      finally {
        tickParts.world = round(performance.now() - start)
      }
    })
    patch(game, 'tick', original => () => {
      tickParts = { physics: null, world: null }
      const start = now()
      try {
        return original()
      }
      finally {
        if (recording)
          capture.ticks.push({ start: round(start), duration: round(now() - start), ...tickParts })
      }
    })

    // ---- Long animation frames (with the scripts that ran), long tasks where those don't exist, user measures
    const observers: { observer: PerformanceObserver, take(entries: PerformanceEntryList): void }[] = []
    const observe = (type: string, onEntry: (entry: PerformanceEntry) => void) => {
      if (typeof PerformanceObserver === 'undefined' || !PerformanceObserver.supportedEntryTypes?.includes(type))
        return false
      const take = (entries: PerformanceEntryList) => entries.forEach((entry) => {
        if (entry.startTime >= t0)
          onEntry(entry)
      })
      const observer = new PerformanceObserver(list => take(list.getEntries()))
      observer.observe({ type, buffered: false })
      observers.push({ observer, take })
      restore.push(() => observer.disconnect())
      return true
    }

    const loaf = observe('long-animation-frame', (entry) => {
      const frame = entry as PerformanceEntry & { blockingDuration?: number, renderStart?: number, styleAndLayoutStart?: number, scripts?: any[] }
      span({
        name: 'Long animation frame',
        category: 'long-animation-frame',
        start: round(entry.startTime - t0),
        duration: round(entry.duration),
        detail: { blockingDuration: frame.blockingDuration, renderStartOffset: frame.renderStart ? round(frame.renderStart - entry.startTime) : undefined },
      })
      for (const script of frame.scripts ?? []) {
        span({
          name: script.sourceFunctionName || script.invoker || 'script',
          category: 'script',
          start: round(script.startTime - t0),
          duration: round(script.duration),
          detail: {
            invoker: script.invoker,
            invokerType: script.invokerType,
            source: script.sourceURL ? `${script.sourceURL}${script.sourceCharPosition >= 0 ? `:${script.sourceCharPosition}` : ''}` : undefined,
            forcedStyleAndLayout: script.forcedStyleAndLayoutDuration ? round(script.forcedStyleAndLayoutDuration) : undefined,
          },
        })
      }
    })
    if (!loaf) {
      observe('longtask', entry => span({ name: 'Long task', category: 'long-task', start: round(entry.startTime - t0), duration: round(entry.duration) }))
    }
    observe('measure', entry => span({ name: entry.name, category: 'measure', start: round(entry.startTime - t0), duration: round(entry.duration) }))

    // ---- JS sampling profiler
    let profiler: ProfilerLike | null = null
    const Profiler = (window as unknown as { Profiler?: ProfilerCtor }).Profiler
    if (!options.jsProfile) {
      capture.jsProfile.note = 'Turned off'
    }
    else if (!Profiler) {
      capture.jsProfile.note = 'The browser has no JS Self-Profiling API (only Chromium browsers have it)'
    }
    else {
      try {
        const sampleInterval = Math.max(1, options.sampleIntervalMs)
        profiler = new Profiler({ sampleInterval, maxBufferSize: Math.ceil(options.durationMs / sampleInterval) + 1000 })
        capture.jsProfile.enabled = true
      }
      catch (err) {
        capture.jsProfile.note = `The JS profiler could not start: ${(err as Error).message}. It needs the page served with `
          + '`Document-Policy: js-profiling`, which the mavonengine Vite plugin adds in dev: reload the tab after updating @mavonengine/core'
      }
    }

    await new Promise(resolve => setTimeout(resolve, options.durationMs))
    recording = false

    if (profiler) {
      try {
        const trace = await profiler.stop()
        capture.profile = {
          sampleIntervalMs: options.sampleIntervalMs,
          resources: trace.resources,
          frames: trace.frames,
          stacks: trace.stacks,
          samples: trace.samples.map(sample => ({ ...sample, timestamp: round(sample.timestamp - t0) })),
        }
      }
      catch (err) {
        capture.jsProfile = { enabled: false, note: `The JS profiler failed: ${(err as Error).message}` }
      }
    }

    // Entries not delivered yet
    observers.forEach(({ observer, take }) => {
      take(observer.takeRecords())
    })

    // The last GPU results arrive a few frames later
    for (let i = 0; i < 10 && pendingQueries.length; i++) {
      await new Promise(resolve => requestAnimationFrame(resolve))
      collectQueries()
    }
    pendingQueries.forEach(({ query }) => gl.deleteQuery(query))

    capture.programs = three.info.programs?.length ?? 0
    return capture
  }
  finally {
    restore.reverse().forEach(undo => undo())
    running = false
  }
}
