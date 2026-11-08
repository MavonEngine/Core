import type { GlCounts, TraceCapture, TraceFrame } from '@mavonengine/core/Dev/trace'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { afterEach, describe, expect, it } from 'vitest'
import GameServerClient from '../src/mcp/GameServerClient'
import { createMcpServer } from '../src/mcp/server'
import { analyzeTrace, hotFunctions, percentile, refreshRate, stackFrames, toTraceEvents } from '../src/mcp/trace'

function gl(overrides: Partial<GlCounts> = {}): GlCounts {
  return {
    draws: 50,
    instancedDraws: 0,
    programSwitches: 10,
    textureBinds: 20,
    framebufferBinds: 2,
    vertexArrayBinds: 50,
    uniformCalls: 300,
    bufferUploads: 0,
    bufferUploadBytes: 0,
    textureUploads: 0,
    textureUploadMs: 0,
    shaderCompiles: 0,
    shaderCompileMs: 0,
    syncCalls: 0,
    syncMs: 0,
    ...overrides,
  }
}

/** `count` frames at 60Hz, then `patch` changes some */
function capture(count = 60, patch: (frame: TraceFrame, index: number) => void = () => {}, extra: Partial<TraceCapture> = {}): TraceCapture {
  const frames: TraceFrame[] = []
  for (let i = 0; i < count; i++) {
    const frame: TraceFrame = { start: 0, interval: i ? 16.7 : null, cpu: 2, gpu: 3, passes: [], calls: 50, triangles: 10000, gl: gl(), heap: 50_000_000 }
    patch(frame, i)
    frames.push(frame)
  }
  // Starts follow from the (patched) intervals
  let at = 0
  frames.forEach((frame) => {
    at += frame.interval ?? 0
    frame.start = at
    frame.passes = [[at, 1.5], [at + 1.5, 0.3]]
  })

  return {
    startedAt: Date.UTC(2026, 10, 8),
    durationMs: 1000,
    userAgent: 'test',
    visible: true,
    canvas: { width: 1920, height: 1080, pixelRatio: 2 },
    passes: ['RenderPass', 'OutputPass'],
    gpuTiming: { enabled: true },
    jsProfile: { enabled: true },
    programs: 4,
    frames,
    ticks: [],
    spans: [],
    profile: null,
    ...extra,
  }
}

describe('trace analysis', () => {
  it('finds the percentile and the refresh rate', () => {
    expect(percentile([1, 2, 3, 4], 50)).toBe(2)
    expect(percentile([], 50)).toBe(0)
    expect(refreshRate(Array.from<number>({ length: 20 }).fill(16.7))).toBe(60)
    expect(refreshRate(Array.from<number>({ length: 20 }).fill(6.9))).toBe(144)
    expect(refreshRate([16])).toBeNull()
  })

  it('calls a frame-rate locked trace smooth', () => {
    const analysis = analyzeTrace(capture())

    expect(analysis.refreshRate).toBe(60)
    expect(analysis.bottleneck.verdict).toBe('smooth')
    expect(analysis.hitches.count).toBe(0)
    expect(analysis.passes).toEqual([{ name: 'RenderPass', avgMs: 1.5, maxMs: 1.5 }, { name: 'OutputPass', avgMs: 0.3, maxMs: 0.3 }])
    expect(analysis.perFrame.drawCalls).toBe(50)
  })

  it('tells a GPU-bound trace apart from a CPU-bound one', () => {
    // Every other frame at vsync keeps the refresh rate visible, the rest are slow
    const slow = (frame: TraceFrame, i: number) => {
      frame.interval = i ? (i % 5 === 0 ? 16.7 : 33.3) : null
    }

    const gpuBound = analyzeTrace(capture(60, (frame, i) => {
      slow(frame, i)
      frame.gpu = 30
    }))
    expect(gpuBound.bottleneck.verdict).toBe('gpu-bound')
    expect(gpuBound.findings.some(f => f.includes('pixel ratio 2'))).toBe(true)

    const cpuBound = analyzeTrace(capture(60, (frame, i) => {
      slow(frame, i)
      frame.cpu = 28
      frame.gpu = 4
      frame.calls = 2400
    }))
    expect(cpuBound.bottleneck.verdict).toBe('cpu-render-bound')
    expect(cpuBound.findings.some(f => f.includes('2400 draw calls'))).toBe(true)
  })

  it('explains a hitch with the work done before it', () => {
    const analysis = analyzeTrace(capture(60, (frame, i) => {
      if (i === 30) {
        frame.interval = 120
        frame.gl = gl({ shaderCompiles: 3, shaderCompileMs: 80, textureUploads: 2, textureUploadMs: 12 })
        frame.heap = 40_000_000
      }
    }, {
      spans: [{ name: 'loadLevel', category: 'script', start: 500, duration: 20, detail: { invoker: 'Promise.then', source: 'http://localhost/src/Level.ts:120' } }],
    }))

    expect(analysis.hitches.count).toBe(1)
    const [hitch] = analysis.hitches.worst
    expect(hitch!.frame).toBe(30)
    expect(hitch!.intervalMs).toBe(120)
    expect(hitch!.causes.join('\n')).toMatch(/Shader compilation: 80ms linking 3 programs/)
    expect(hitch!.causes.join('\n')).toMatch(/Texture uploads: 12ms/)
    expect(hitch!.causes.join('\n')).toMatch(/heap dropped 9\.5MB/)
    expect(hitch!.causes.join('\n')).toMatch(/Script loadLevel ran 20ms \(Promise\.then\)/)
    expect(analysis.findings[0]).toContain('compileAsync')
  })

  it('says when nothing in the tab explains a hitch', () => {
    const analysis = analyzeTrace(capture(60, (frame, i) => {
      if (i === 10)
        frame.interval = 50
    }))
    expect(analysis.hitches.worst[0]!.causes[0]).toContain('No cause recorded')
  })

  it('notes a hidden tab and missing APIs', () => {
    const analysis = analyzeTrace(capture(1, () => {}, { visible: false, gpuTiming: { enabled: false, note: 'no extension' }, jsProfile: { enabled: false, note: 'no API' } }))
    expect(analysis.notes.join('\n')).toMatch(/background/)
    expect(analysis.notes.join('\n')).toMatch(/GPU timing: off, no extension/)
    expect(analysis.notes.join('\n')).toMatch(/JS sampling: off, no API/)
    expect(analysis.bottleneck.verdict).toBe('unknown')
  })
})

describe('js profile', () => {
  // main -> update -> physics, and main -> render
  const profile = {
    sampleIntervalMs: 10,
    resources: ['http://localhost:5173/src/Game.ts', 'http://localhost:5173/node_modules/.vite/deps/three.js?v=abc'],
    frames: [
      { name: 'main', resourceId: 0, line: 1, column: 1 },
      { name: 'update', resourceId: 0, line: 10, column: 3 },
      { name: 'step', resourceId: 1, line: 500, column: 7 },
      { name: '', resourceId: 1, line: 900, column: 2 },
    ],
    stacks: [
      { frameId: 0 },
      { frameId: 1, parentId: 0 },
      { frameId: 2, parentId: 1 },
      { frameId: 3, parentId: 0 },
    ],
    samples: [
      { timestamp: 0, stackId: 2 },
      { timestamp: 10, stackId: 2 },
      { timestamp: 20, stackId: 1 },
      { timestamp: 30, stackId: 3 },
      { timestamp: 40 },
    ],
  }

  it('walks stacks root first', () => {
    expect(stackFrames(profile, 2)).toEqual([0, 1, 2])
    expect(stackFrames(profile, undefined)).toEqual([])
  })

  it('ranks functions by self time', () => {
    const { busyMs, idleMs, functions } = hotFunctions(profile)
    expect(busyMs).toBe(40)
    expect(idleMs).toBe(10)
    expect(functions[0]).toEqual({ name: 'step', location: 'deps/three.js:500:7', selfMs: 20, totalMs: 20, selfPercent: 50 })
    expect(functions.find(f => f.name === 'main')).toMatchObject({ selfMs: 0, totalMs: 40 })
    expect(functions.find(f => f.name === '(anonymous)')).toMatchObject({ location: 'deps/three.js:900:2' })
  })

  it('merges samples into nested spans for the flame chart', () => {
    const events = toTraceEvents(capture(2, () => {}, { profile })).traceEvents.filter(e => e.cat === 'js')
    const span = (name: string) => events.filter(e => e.name === name).map(e => [e.ts / 1000, e.dur! / 1000])

    expect(span('main')).toEqual([[0, 40]])
    expect(span('update')).toEqual([[0, 30]])
    expect(span('step')).toEqual([[0, 20]])
    expect(span('(anonymous)')).toEqual([[30, 10]])
  })

  it('writes frames, passes, GPU time, counters and track names', () => {
    const { traceEvents } = toTraceEvents(capture(3))
    expect(traceEvents.filter(e => e.cat === 'frame')).toHaveLength(3)
    expect(traceEvents.filter(e => e.cat === 'pass').map(e => e.name)).toEqual(['RenderPass', 'OutputPass', 'RenderPass', 'OutputPass', 'RenderPass', 'OutputPass'])
    expect(traceEvents.filter(e => e.cat === 'gpu')[0]).toMatchObject({ dur: 3000 })
    expect(traceEvents.some(e => e.ph === 'C' && e.name === 'Frame')).toBe(true)
    expect(traceEvents.filter(e => e.name === 'thread_name').map(e => e.args!.name)).toContain('JS samples')
  })
})

describe('client_trace', () => {
  let dir: string | undefined
  afterEach(() => {
    if (dir)
      rmSync(dir, { recursive: true, force: true })
    dir = undefined
  })

  it('asks the tab to record, analyses it and saves the trace file', async () => {
    dir = mkdtempSync(join(tmpdir(), 'trace-'))
    const savePath = join(dir, 'nested', 'trace.json')
    const asked: URL[] = []
    const fetch = (async (input: URL) => {
      const url = new URL(input)
      asked.push(url)
      return url.pathname === '/__mavonengine/clients/auto/trace' ? Response.json(capture()) : new Response('', { status: 404 })
    }) as unknown as typeof globalThis.fetch

    const server = createMcpServer(new GameServerClient({ url: 'http://localhost:8050', fetch }))
    const client = new Client({ name: 'test', version: '0' })
    const [a, b] = InMemoryTransport.createLinkedPair()
    await Promise.all([server.connect(a), client.connect(b)])

    const result = await client.callTool({ name: 'client_trace', arguments: { durationMs: 1000, jsProfile: false, savePath } }) as any
    expect(result.isError).toBeFalsy()
    const data = JSON.parse(result.content[0].text)

    expect(Object.fromEntries(asked[0]!.searchParams)).toEqual({ durationMs: '1000', jsProfile: 'false', sampleIntervalMs: '10', gpu: 'true' })
    expect(data.bottleneck.verdict).toBe('smooth')
    expect(data.traceFile).toBe(savePath)
    expect(existsSync(savePath)).toBe(true)
    expect(JSON.parse(readFileSync(savePath, 'utf8')).traceEvents.length).toBeGreaterThan(60)
  })
})
