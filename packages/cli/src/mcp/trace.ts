import type { GlCounts, TraceCapture, TraceFrame, TraceProfile, TraceSpan } from '@mavonengine/core/Dev/trace'

/**
 * Turns a `trace` capture from a game tab into an analysis for the model (frame times, bottleneck, hitches with
 * their likely causes, hot JS functions, WebGL load) and into a Chrome Trace Event file for flame charts.
 */

const REFRESH_RATES = [30, 50, 60, 75, 90, 100, 120, 144, 165, 180, 240, 360]
/** Heap shrinking this much between frames is taken as a garbage collection */
const GC_DROP_BYTES = 1024 * 1024
const MB = 1024 * 1024

const VITE_DEPS_RE = /^\/node_modules\/\.vite\/deps\//
const LEADING_SLASH_RE = /^\//

const round = (n: number, digits = 2) => Math.round(n * 10 ** digits) / 10 ** digits

export function percentile(values: number[], p: number): number {
  if (!values.length)
    return 0
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))]!
}

function stats(values: number[]) {
  if (!values.length)
    return null
  const sum = values.reduce((a, b) => a + b, 0)
  return { avg: round(sum / values.length), p50: round(percentile(values, 50)), p95: round(percentile(values, 95)), p99: round(percentile(values, 99)), max: round(Math.max(...values)) }
}

/** The display refresh rate the frame intervals settle at */
export function refreshRate(intervals: number[]): number | null {
  if (intervals.length < 5)
    return null
  // The fast frames show the vsync interval, slow ones are dropped frames
  const hz = 1000 / percentile(intervals, 20)
  return REFRESH_RATES.reduce((best, rate) => Math.abs(rate - hz) < Math.abs(best - hz) ? rate : best)
}

// ---- JS profile

export interface ProfileFrameInfo {
  name: string
  location: string | null
}

/** Function name and short `file:line:column` of a profile frame */
export function frameLabel(profile: TraceProfile, frameId: number): ProfileFrameInfo {
  const frame = profile.frames[frameId]
  if (!frame)
    return { name: '(unknown)', location: null }
  const resource = frame.resourceId !== undefined ? profile.resources[frame.resourceId] : undefined
  let file: string | null = null
  if (resource) {
    try {
      const url = new URL(resource)
      // Vite serves dependencies from /node_modules/.vite/deps/<name>.js?v=<hash>
      file = url.pathname.replace(VITE_DEPS_RE, 'deps/').replace(LEADING_SLASH_RE, '')
    }
    catch {
      file = resource
    }
  }
  return {
    name: frame.name || '(anonymous)',
    location: file ? `${file}${frame.line !== undefined ? `:${frame.line}` : ''}${frame.column !== undefined ? `:${frame.column}` : ''}` : null,
  }
}

/** Frame ids of a sample's stack, root first */
export function stackFrames(profile: TraceProfile, stackId: number | undefined): number[] {
  const frames: number[] = []
  const seen = new Set<number>()
  let id = stackId
  while (id !== undefined && !seen.has(id)) {
    seen.add(id)
    const stack = profile.stacks[id]
    if (!stack)
      break
    frames.push(stack.frameId)
    id = stack.parentId
  }
  return frames.reverse()
}

/** Each sample with how long it stands for: until the next sample, the interval for the last */
function weightedSamples(profile: TraceProfile) {
  return profile.samples.map((sample, i) => {
    const next = profile.samples[i + 1]
    const weight = next ? Math.min(next.timestamp - sample.timestamp, profile.sampleIntervalMs * 4) : profile.sampleIntervalMs
    return { ...sample, weight: Math.max(0, weight) }
  })
}

export interface HotFunction {
  name: string
  location: string | null
  /** ms where it was the function running */
  selfMs: number
  /** ms where it was on the stack */
  totalMs: number
  selfPercent: number
}

/** Functions with the most self time between `from` and `to` (ms since the trace started) */
export function hotFunctions(profile: TraceProfile, limit = 15, from = -Infinity, to = Infinity): { busyMs: number, idleMs: number, functions: HotFunction[] } {
  const byKey = new Map<string, HotFunction>()
  let busyMs = 0
  let idleMs = 0

  for (const sample of weightedSamples(profile)) {
    if (sample.timestamp < from || sample.timestamp > to)
      continue
    const frames = stackFrames(profile, sample.stackId)
    if (!frames.length) {
      idleMs += sample.weight
      continue
    }
    busyMs += sample.weight

    const keys = frames.map((frameId) => {
      const label = frameLabel(profile, frameId)
      const key = `${label.name}@${label.location}`
      if (!byKey.has(key))
        byKey.set(key, { ...label, selfMs: 0, totalMs: 0, selfPercent: 0 })
      return key
    })
    for (const key of new Set(keys))
      byKey.get(key)!.totalMs += sample.weight
    byKey.get(keys.at(-1)!)!.selfMs += sample.weight
  }

  const functions = [...byKey.values()]
    .sort((a, b) => b.selfMs - a.selfMs)
    .slice(0, limit)
    .map(fn => ({ ...fn, selfMs: round(fn.selfMs, 1), totalMs: round(fn.totalMs, 1), selfPercent: busyMs ? round((fn.selfMs / busyMs) * 100, 1) : 0 }))

  return { busyMs: round(busyMs, 1), idleMs: round(idleMs, 1), functions }
}

// ---- Analysis

export interface Hitch {
  frame: number
  /** ms since the trace started */
  at: number
  intervalMs: number
  cpuMs: number
  gpuMs: number | null
  causes: string[]
}

const sum = (values: number[]) => values.reduce((a, b) => a + b, 0)
const mean = (values: number[]) => values.length ? sum(values) / values.length : 0

function overlaps(span: { start: number, duration: number }, from: number, to: number) {
  return span.start < to && span.start + span.duration > from
}

/** What happened in the time before `frame` began, which delayed it */
function hitchCauses(capture: TraceCapture, index: number, budgetMs: number): string[] {
  const frame = capture.frames[index]!
  const previous = capture.frames[index - 1]
  const from = previous ? previous.start : frame.start - (frame.interval ?? 0)
  const to = frame.start + frame.cpu
  const causes: string[] = []
  const gl = [previous?.gl, frame.gl].filter(Boolean) as GlCounts[]

  const compileMs = sum(gl.map(g => g.shaderCompileMs))
  const compiles = sum(gl.map(g => g.shaderCompiles))
  if (compileMs >= 1)
    causes.push(`Shader compilation: ${round(compileMs, 1)}ms${compiles ? ` linking ${compiles} program${compiles === 1 ? '' : 's'}` : ''} (a material or light setup rendered for the first time)`)

  const uploadMs = sum(gl.map(g => g.textureUploadMs))
  if (uploadMs >= 1)
    causes.push(`Texture uploads: ${round(uploadMs, 1)}ms for ${sum(gl.map(g => g.textureUploads))} upload(s)`)

  const bufferBytes = sum(gl.map(g => g.bufferUploadBytes))
  if (bufferBytes >= MB)
    causes.push(`Buffer uploads: ${round(bufferBytes / MB, 1)}MB of geometry/attributes`)

  const syncMs = sum(gl.map(g => g.syncMs))
  if (syncMs >= 1)
    causes.push(`GPU sync stalls: ${round(syncMs, 1)}ms in readPixels/getError/finish/clientWaitSync`)

  if (frame.cpu > budgetMs)
    causes.push(`Render CPU time ${round(frame.cpu, 1)}ms (${frame.calls} draw calls)`)
  if (frame.gpu !== null && frame.gpu > budgetMs)
    causes.push(`GPU time ${round(frame.gpu, 1)}ms`)

  for (const tick of capture.ticks) {
    if (overlaps(tick, from, to) && tick.duration >= Math.max(4, budgetMs / 3)) {
      const parts = [tick.physics !== null && `physics ${round(tick.physics, 1)}ms`, tick.world !== null && `world.update ${round(tick.world, 1)}ms`].filter(Boolean)
      causes.push(`Game tick took ${round(tick.duration, 1)}ms${parts.length ? ` (${parts.join(', ')})` : ''}`)
    }
  }

  if (previous?.heap != null && frame.heap != null && previous.heap - frame.heap >= GC_DROP_BYTES)
    causes.push(`Garbage collection likely: JS heap dropped ${round((previous.heap - frame.heap) / MB, 1)}MB`)

  const scripts = capture.spans
    .filter(s => s.category === 'script' && overlaps(s, from, to) && s.duration >= 2)
    .sort((a, b) => b.duration - a.duration)
    .slice(0, 3)
  for (const script of scripts) {
    const detail = script.detail ?? {}
    causes.push(`Script ${script.name} ran ${round(script.duration, 1)}ms${detail.invoker ? ` (${String(detail.invoker)})` : ''}${detail.source ? ` at ${String(detail.source)}` : ''}${detail.forcedStyleAndLayout ? `, forced layout ${String(detail.forcedStyleAndLayout)}ms` : ''}`)
  }

  const measures = capture.spans.filter(s => s.category === 'measure' && overlaps(s, from, to) && s.duration >= 1)
  for (const measure of measures.sort((a, b) => b.duration - a.duration).slice(0, 3))
    causes.push(`performance.measure "${measure.name}" ${round(measure.duration, 1)}ms`)

  if (capture.profile) {
    const { functions } = hotFunctions(capture.profile, 3, from, to)
    const hot = functions.filter(fn => fn.selfMs >= capture.profile!.sampleIntervalMs)
    if (hot.length)
      causes.push(`Hot JS in this frame: ${hot.map(fn => `${fn.name} ${fn.selfMs}ms${fn.location ? ` (${fn.location})` : ''}`).join(', ')}`)
  }

  if (!causes.length)
    causes.push('No cause recorded in the tab: the browser or OS held the frame back (another tab, compositor, GPU process, power saving), or work outside the game loop')

  return causes
}

export interface TraceAnalysis {
  durationMs: number
  frames: number
  fps: number
  refreshRate: number | null
  budgetMs: number | null
  frameInterval: ReturnType<typeof stats>
  renderCpu: ReturnType<typeof stats>
  gpu: ReturnType<typeof stats>
  tick: (ReturnType<typeof stats> & { count: number, physics: ReturnType<typeof stats>, world: ReturnType<typeof stats> }) | null
  passes: { name: string, avgMs: number, maxMs: number }[]
  perFrame: Record<string, number>
  totals: { shaderCompiles: number, shaderCompileMs: number, textureUploads: number, textureUploadMs: number, bufferUploadMB: number, syncCalls: number, syncMs: number }
  bottleneck: { verdict: 'smooth' | 'gpu-bound' | 'cpu-render-bound' | 'cpu-game-logic-bound' | 'main-thread-busy' | 'unknown', reason: string }
  hitches: { count: number, thresholdMs: number, worst: Hitch[] }
  js: { mainThreadBusyPercent: number, hotFunctions: HotFunction[] } | null
  longAnimationFrames: number
  measures: { name: string, count: number, avgMs: number, maxMs: number }[]
  findings: string[]
  notes: string[]
}

/**
 * The capture summarised: frame time distribution, where frame time goes, the bottleneck, the worst hitches and why
 */
export function analyzeTrace(capture: TraceCapture, { maxHitches = 10 } = {}): TraceAnalysis {
  const frames = capture.frames
  const intervals = frames.map(f => f.interval).filter((n): n is number => n !== null)
  const hz = refreshRate(intervals)
  const budgetMs = hz ? 1000 / hz : null
  const medianInterval = percentile(intervals, 50)
  const gpuTimes = frames.map(f => f.gpu).filter((n): n is number => n !== null)
  const cpuTimes = frames.map(f => f.cpu)
  const notes: string[] = []
  const findings: string[] = []

  if (!capture.visible)
    notes.push('The tab was in the background: browsers throttle or stop rendering hidden tabs, so bring it to the front and trace again')
  if (frames.length < 2)
    notes.push('Fewer than two frames rendered while tracing: the tab is hidden, frozen or stuck before its first frame')
  if (!capture.gpuTiming.enabled || capture.gpuTiming.note)
    notes.push(`GPU timing: ${capture.gpuTiming.enabled ? 'on' : 'off'}${capture.gpuTiming.note ? `, ${capture.gpuTiming.note}` : ''}`)
  if (!capture.jsProfile.enabled)
    notes.push(`JS sampling: off, ${capture.jsProfile.note ?? 'not available'}`)

  // ---- Ticks
  const ticks = capture.ticks
  const tickStats = ticks.length
    ? {
        ...stats(ticks.map(t => t.duration))!,
        count: ticks.length,
        physics: stats(ticks.map(t => t.physics).filter((n): n is number => n !== null)),
        world: stats(ticks.map(t => t.world).filter((n): n is number => n !== null)),
      }
    : null

  // ---- Passes
  const passes = capture.passes.map((name, i) => {
    const times = frames.map(f => f.passes[i]?.[1]).filter((n): n is number => n !== undefined)
    return { name, avgMs: round(mean(times)), maxMs: round(times.length ? Math.max(...times) : 0) }
  })

  // ---- WebGL load, per frame. The first frame also holds calls from before the trace started, so it's left out when there are others
  const steady = frames.length > 1 ? frames.slice(1) : frames
  const avg = (pick: (f: TraceFrame) => number) => round(mean(steady.map(pick)), 1)
  const perFrame = {
    drawCalls: avg(f => f.calls),
    triangles: Math.round(mean(steady.map(f => f.triangles))),
    glDraws: avg(f => f.gl.draws),
    instancedDraws: avg(f => f.gl.instancedDraws),
    programSwitches: avg(f => f.gl.programSwitches),
    textureBinds: avg(f => f.gl.textureBinds),
    framebufferBinds: avg(f => f.gl.framebufferBinds),
    vertexArrayBinds: avg(f => f.gl.vertexArrayBinds),
    uniformCalls: avg(f => f.gl.uniformCalls),
    bufferUploads: avg(f => f.gl.bufferUploads),
    bufferUploadKB: round(mean(steady.map(f => f.gl.bufferUploadBytes)) / 1024, 1),
    textureUploads: avg(f => f.gl.textureUploads),
  }
  const totalOf = (pick: (g: GlCounts) => number) => sum(frames.map(f => pick(f.gl)))
  const totals = {
    shaderCompiles: totalOf(g => g.shaderCompiles),
    shaderCompileMs: round(totalOf(g => g.shaderCompileMs), 1),
    textureUploads: totalOf(g => g.textureUploads),
    textureUploadMs: round(totalOf(g => g.textureUploadMs), 1),
    bufferUploadMB: round(totalOf(g => g.bufferUploadBytes) / MB),
    syncCalls: totalOf(g => g.syncCalls),
    syncMs: round(totalOf(g => g.syncMs), 1),
  }

  // ---- JS
  const js = capture.profile ? hotFunctions(capture.profile, 15) : null
  const busyPercent = js && js.busyMs + js.idleMs > 0 ? round((js.busyMs / (js.busyMs + js.idleMs)) * 100, 1) : null

  // ---- Bottleneck
  const cpuP50 = percentile(cpuTimes, 50)
  const gpuP50 = gpuTimes.length ? percentile(gpuTimes, 50) : null
  const tickPerFrame = ticks.length && frames.length ? sum(ticks.map(t => t.duration)) / frames.length : 0
  let bottleneck: TraceAnalysis['bottleneck']
  if (!budgetMs || frames.length < 5) {
    bottleneck = { verdict: 'unknown', reason: 'Too few frames to tell' }
  }
  else if (medianInterval <= budgetMs * 1.15 && (hz! >= 60 || Math.max(cpuP50 + tickPerFrame, gpuP50 ?? 0) < medianInterval * 0.6)) {
    // Below 60Hz a steady rate is as likely a slow game as a slow display, so only call it vsync with headroom left
    const used = Math.max(cpuP50 + tickPerFrame, gpuP50 ?? 0)
    bottleneck = { verdict: 'smooth', reason: `Frames keep up with the ${hz}Hz display: a typical frame uses ${round(used, 1)}ms of the ${round(budgetMs, 1)}ms budget (render CPU ${round(cpuP50, 1)}ms${gpuP50 !== null ? `, GPU ${round(gpuP50, 1)}ms` : ''}, game ticks ~${round(tickPerFrame, 1)}ms per frame)` }
  }
  else if (gpuP50 !== null && gpuP50 >= medianInterval * 0.75 && gpuP50 > cpuP50 + tickPerFrame) {
    bottleneck = { verdict: 'gpu-bound', reason: `The GPU needs ${round(gpuP50, 1)}ms per frame against frames every ${round(medianInterval, 1)}ms, while render CPU time is ${round(cpuP50, 1)}ms` }
  }
  else if (cpuP50 >= medianInterval * 0.6) {
    bottleneck = { verdict: 'cpu-render-bound', reason: `Renderer.update takes ${round(cpuP50, 1)}ms of each ${round(medianInterval, 1)}ms frame on the CPU, submitting ${perFrame.drawCalls} draw calls` }
  }
  else if (tickPerFrame >= medianInterval * 0.4) {
    bottleneck = { verdict: 'cpu-game-logic-bound', reason: `Game ticks take ~${round(tickPerFrame, 1)}ms per rendered frame (tick p50 ${tickStats?.p50}ms at ${ticks.length} ticks)` }
  }
  else if (busyPercent !== null && busyPercent >= 70) {
    bottleneck = { verdict: 'main-thread-busy', reason: `The main thread is busy ${busyPercent}% of the time outside what the render and tick account for: see js.hotFunctions` }
  }
  else {
    bottleneck = { verdict: 'unknown', reason: `Frames take ${round(medianInterval, 1)}ms against a ${round(budgetMs, 1)}ms budget, but neither render CPU (${round(cpuP50, 1)}ms), GPU (${gpuP50 !== null ? `${round(gpuP50, 1)}ms` : 'not measured'}) nor ticks explain it` }
  }

  // ---- Hitches: frames that came at least half a frame late
  const thresholdMs = round(Math.max(medianInterval * 1.5, medianInterval + 4))
  const late = frames
    .map((frame, index) => ({ frame, index }))
    .filter(({ frame }) => frame.interval !== null && frame.interval > thresholdMs)
  const worst = [...late]
    .sort((a, b) => b.frame.interval! - a.frame.interval!)
    .slice(0, maxHitches)
    .map(({ frame, index }) => ({
      frame: index,
      at: round(frame.start, 1),
      intervalMs: round(frame.interval!, 1),
      cpuMs: round(frame.cpu, 1),
      gpuMs: frame.gpu === null ? null : round(frame.gpu, 1),
      causes: hitchCauses(capture, index, budgetMs ?? medianInterval),
    }))

  // ---- Findings
  if (totals.shaderCompiles > 0)
    findings.push(`${totals.shaderCompiles} shader program(s) were linked while playing (${totals.shaderCompileMs}ms on the main thread). Compile materials up front with renderer.compileAsync(scene, camera) after loading, and avoid changing defines / light counts at runtime`)
  if (perFrame.drawCalls > 1000)
    findings.push(`${perFrame.drawCalls} draw calls per frame is a lot for WebGL: merge static meshes, use InstancedMesh / BatchedMesh for repeated objects, and share materials`)
  else if (perFrame.drawCalls > 300 && bottleneck.verdict === 'cpu-render-bound')
    findings.push(`${perFrame.drawCalls} draw calls per frame drive the render CPU time: instancing or merging would cut it`)
  if (perFrame.programSwitches > 100)
    findings.push(`${perFrame.programSwitches} shader program switches per frame: fewer distinct materials, or the same material on more meshes, lets three.js sort and batch`)
  if (perFrame.textureUploads >= 1)
    findings.push(`${perFrame.textureUploads} texture upload(s) every frame: a texture (often a canvas, video or DataTexture) has needsUpdate set each frame`)
  if (perFrame.bufferUploadKB >= 256)
    findings.push(`${perFrame.bufferUploadKB}KB of buffer data uploaded per frame: geometry attributes are updated every frame (needsUpdate / updateRanges), consider updating only the ranges that change`)
  if (totals.syncCalls > frames.length && totals.syncMs >= 1)
    findings.push(`${totals.syncCalls} GPU sync calls (${totals.syncMs}ms): readPixels / getError stall the pipeline. renderer.debug.checkShaderErrors = true calls getError after compiles, and picking with readPixels each frame stalls too`)
  if (bottleneck.verdict === 'gpu-bound') {
    findings.push(`GPU-bound at ${capture.canvas.width}x${capture.canvas.height} (pixel ratio ${capture.canvas.pixelRatio}): lower the pixel ratio (cap it at 1.5–2), shadow map size or shadow-casting lights, and look at the most expensive passes`)
    const heavyPasses = passes.filter(p => p.name !== 'RenderPass' && p.name !== 'OutputPass')
    if (heavyPasses.length)
      findings.push(`Post-processing passes cost GPU fill rate on every pixel: ${heavyPasses.map(p => p.name).join(', ')}`)
  }
  if (tickStats && budgetMs && tickStats.p95 > budgetMs / 2)
    findings.push(`Game ticks are slow (p95 ${tickStats.p95}ms${tickStats.physics ? `, physics p95 ${tickStats.physics.p95}ms` : ''}${tickStats.world ? `, world.update p95 ${tickStats.world.p95}ms` : ''}) and block rendering when they run`)
  const gcHitches = worst.filter(h => h.causes.some(c => c.startsWith('Garbage collection'))).length
  if (gcHitches >= 2)
    findings.push(`${gcHitches} hitches line up with garbage collection: reuse Vector3 / Matrix4 / arrays in update loops instead of allocating each frame`)
  if (late.length && budgetMs)
    findings.push(`${late.length} of ${frames.length} frames came late (over ${thresholdMs}ms), ${round((late.length / frames.length) * 100, 1)}%`)

  // ---- Measures
  const measureMap = new Map<string, number[]>()
  for (const span of capture.spans.filter(s => s.category === 'measure'))
    measureMap.set(span.name, [...(measureMap.get(span.name) ?? []), span.duration])
  const measures = Array.from(measureMap, ([name, durations]) => ({ name, count: durations.length, avgMs: round(mean(durations)), maxMs: round(Math.max(...durations)) }))
    .sort((a, b) => b.avgMs * b.count - a.avgMs * a.count)
    .slice(0, 20)

  return {
    durationMs: capture.durationMs,
    frames: frames.length,
    fps: round(frames.length / (capture.durationMs / 1000), 1),
    refreshRate: hz,
    budgetMs: budgetMs && round(budgetMs),
    frameInterval: stats(intervals),
    renderCpu: stats(cpuTimes),
    gpu: stats(gpuTimes),
    tick: tickStats,
    passes,
    perFrame,
    totals,
    bottleneck,
    hitches: { count: late.length, thresholdMs, worst },
    js: js && { mainThreadBusyPercent: busyPercent ?? 0, hotFunctions: js.functions },
    longAnimationFrames: capture.spans.filter(s => s.category === 'long-animation-frame' || s.category === 'long-task').length,
    measures,
    findings,
    notes,
  }
}

// ---- Chrome Trace Event format, for Perfetto (ui.perfetto.dev), chrome://tracing and speedscope

interface TraceEvent {
  name: string
  ph: 'X' | 'C' | 'M' | 'i'
  ts: number
  pid: number
  tid: number
  dur?: number
  cat?: string
  s?: 'g' | 'p' | 't'
  args?: Record<string, unknown>
}

const PID = 1
const TRACKS = { frames: 1, passes: 2, gpu: 3, ticks: 4, js: 5, gl: 6, browser: 7 } as const
const TRACK_NAMES: Record<number, string> = {
  [TRACKS.frames]: 'Frames (render CPU)',
  [TRACKS.passes]: 'Composer passes',
  [TRACKS.gpu]: 'GPU time per frame (duration, not GPU clock)',
  [TRACKS.ticks]: 'Game ticks',
  [TRACKS.js]: 'JS samples',
  [TRACKS.gl]: 'Slow WebGL calls',
  [TRACKS.browser]: 'Long animation frames, scripts, measures',
}

const us = (ms: number) => Math.round(ms * 1000)

/** The JS samples as nested spans: consecutive samples that share stack frames become one span per frame */
function profileEvents(profile: TraceProfile): TraceEvent[] {
  const events: TraceEvent[] = []
  const open: { frameId: number, start: number }[] = []

  const close = (depth: number, at: number) => {
    while (open.length > depth) {
      const { frameId, start } = open.pop()!
      const label = frameLabel(profile, frameId)
      events.push({ name: label.name, cat: 'js', ph: 'X', ts: us(start), dur: Math.max(1, us(at - start)), pid: PID, tid: TRACKS.js, args: label.location ? { location: label.location } : undefined })
    }
  }

  const samples = weightedSamples(profile)
  for (const sample of samples) {
    const frames = stackFrames(profile, sample.stackId)
    let common = 0
    while (common < open.length && common < frames.length && open[common]!.frameId === frames[common])
      common++
    close(common, sample.timestamp)
    for (let i = common; i < frames.length; i++)
      open.push({ frameId: frames[i]!, start: sample.timestamp })
  }
  const last = samples.at(-1)
  close(0, last ? last.timestamp + last.weight : 0)
  return events
}

function spanEvent(span: TraceSpan): TraceEvent {
  return {
    name: span.name,
    cat: span.category,
    ph: 'X',
    ts: us(span.start),
    dur: Math.max(1, us(span.duration)),
    pid: PID,
    tid: span.category === 'gl' ? TRACKS.gl : TRACKS.browser,
    args: span.detail,
  }
}

/**
 * The capture as Chrome Trace Event JSON: one track per kind of work, frames with their passes nested below,
 * the JS samples as a flame chart, and counters for FPS, draw calls and heap
 */
export function toTraceEvents(capture: TraceCapture, label = 'MavonEngine game tab'): { traceEvents: TraceEvent[], displayTimeUnit: 'ms', metadata: Record<string, unknown> } {
  const events: TraceEvent[] = [
    { name: 'process_name', ph: 'M', ts: 0, pid: PID, tid: 0, args: { name: label } },
    ...Object.entries(TRACK_NAMES).flatMap(([tid, name]) => [
      { name: 'thread_name', ph: 'M' as const, ts: 0, pid: PID, tid: Number(tid), args: { name } },
      { name: 'thread_sort_index', ph: 'M' as const, ts: 0, pid: PID, tid: Number(tid), args: { sort_index: Number(tid) } },
    ]),
  ]

  capture.frames.forEach((frame, index) => {
    events.push({
      name: `Frame ${index}`,
      cat: 'frame',
      ph: 'X',
      ts: us(frame.start),
      dur: Math.max(1, us(frame.cpu)),
      pid: PID,
      tid: TRACKS.frames,
      args: { intervalMs: frame.interval, cpuMs: frame.cpu, gpuMs: frame.gpu, drawCalls: frame.calls, triangles: frame.triangles, gl: frame.gl },
    })
    frame.passes.forEach((pass, i) => {
      const [start, duration] = pass ?? []
      if (start !== undefined && duration !== undefined)
        events.push({ name: capture.passes[i] ?? `Pass ${i}`, cat: 'pass', ph: 'X', ts: us(start), dur: Math.max(1, us(duration)), pid: PID, tid: TRACKS.passes })
    })
    if (frame.gpu !== null)
      events.push({ name: `GPU frame ${index}`, cat: 'gpu', ph: 'X', ts: us(frame.start), dur: Math.max(1, us(frame.gpu)), pid: PID, tid: TRACKS.gpu })

    const counters: Record<string, number> = { drawCalls: frame.calls, glDraws: frame.gl.draws }
    if (frame.interval)
      counters.fps = round(1000 / frame.interval, 1)
    events.push({ name: 'Frame', ph: 'C', ts: us(frame.start), pid: PID, tid: 0, args: counters })
    if (frame.heap !== null)
      events.push({ name: 'JS heap (MB)', ph: 'C', ts: us(frame.start), pid: PID, tid: 0, args: { used: round(frame.heap / MB) } })
  })

  for (const tick of capture.ticks) {
    events.push({ name: 'tick', cat: 'tick', ph: 'X', ts: us(tick.start), dur: Math.max(1, us(tick.duration)), pid: PID, tid: TRACKS.ticks, args: { physicsMs: tick.physics, worldMs: tick.world } })
  }

  events.push(...capture.spans.map(spanEvent))
  if (capture.profile)
    events.push(...profileEvents(capture.profile))

  return {
    traceEvents: events,
    displayTimeUnit: 'ms',
    metadata: {
      source: 'mavonengine mcp client_trace',
      startedAt: new Date(capture.startedAt).toISOString(),
      userAgent: capture.userAgent,
      canvas: capture.canvas,
      gpuTiming: capture.gpuTiming,
      jsProfile: capture.jsProfile,
    },
  }
}
