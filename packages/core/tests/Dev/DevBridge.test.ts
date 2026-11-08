// @vitest-environment jsdom
import type { BridgeRequest } from '../../src/Dev/bridgeProtocol'
import { Vector3 } from 'three'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { BRIDGE_HELLO, BRIDGE_REQUEST, BRIDGE_RESPONSE } from '../../src/Dev/bridgeProtocol'
import { answer, formatArgs, pushLog, resetDevBridgeLogs, startDevBridge } from '../../src/Dev/DevBridge'
import BaseWorld from '../../src/World/BaseWorld'
import GameObject from '../../src/World/GameObject'

class Rock extends GameObject {
  update(): void {}
}

class Character extends GameObject {
  constructor(id: string, public isLocalPlayer: boolean, position = new Vector3()) {
    super(id, position)
  }

  update(): void {}
}

function fakeGame() {
  const world = new BaseWorld()
  world.add({
    rock: new Rock('rock', new Vector3(10, 0, 0)),
    localPlayer: new Character('localPlayer', true, new Vector3(1, 0, 0)),
    other: new Character('other', false, new Vector3(2, 0, 0)),
  })

  const info = { autoReset: true, reset: vi.fn(), render: { calls: 12, triangles: 3400, points: 0, lines: 2 }, memory: { geometries: 5, textures: 3 }, programs: [{}, {}] }
  return {
    world,
    tickRate: 30,
    activeScene: undefined,
    editor: undefined,
    canvas: { width: 800, height: 600 },
    renderer: { fps: 59.6, instance: { info, getPixelRatio: () => 2 }, composer: { render: vi.fn() } },
    camera: { instance: { position: new Vector3(0, 5, 10), rotation: new Vector3(), fov: 75, near: 0.1, far: 1000 } },
    resources: { loaded: 2, toLoad: 2 },
    network: {
      connected: true,
      socket: { id: 'socket-1' },
      ping: 42,
      editorMode: false,
      localCommandQueue: [{}, {}, {}],
      currentSequenceId: 17,
    },
  }
}

const ask = (query: BridgeRequest['query'], params: Record<string, string> = {}) => answer({ requestId: 'r', query, params })

beforeEach(() => {
  (window as any).Game = fakeGame()
})

afterEach(() => {
  delete (window as any).Game
  resetDevBridgeLogs()
})

describe('answer', () => {
  it('reports the tab and its player id', async () => {
    const res = await ask('info')
    expect(res).toMatchObject({ ok: true, data: { playerId: 'socket-1', editor: false, fps: 60 } })
  })

  it('reports renderer stats for one frame', async () => {
    const res = await ask('status') as any
    expect(res.ok).toBe(true)
    expect(res.data).toMatchObject({
      tickRate: 30,
      gpuMemory: { geometries: 5, textures: 3, programs: 2 },
      canvas: { width: 800, height: 600, pixelRatio: 2 },
      camera: { position: { x: 0, y: 5, z: 10 }, fov: 75 },
      entities: 3,
      scene: null,
    })
    // renderer.info is put back to resetting every render
    expect((window as any).Game.renderer.instance.info.autoReset).toBe(true)
  })

  it('lists entities with the local player marked, using the server filters', async () => {
    const res = await ask('entities', { near: '0,0,0', limit: '2' }) as any
    expect(res.data.total).toBe(3)
    expect(res.data.entities.map((e: any) => [e.id, e.player, e.localPlayer])).toEqual([
      ['localPlayer', true, true],
      ['other', true, false],
    ])

    expect(await ask('entities', { near: '1,2' })).toEqual({ requestId: 'r', ok: false, error: 'near must be x,y,z' })
  })

  it('finds the local player by its server id', async () => {
    const res = await ask('entity', { id: 'socket-1' }) as any
    expect(res.data.entity).toMatchObject({ id: 'localPlayer', localPlayer: true, position: { x: 1, y: 0, z: 0 } })
    expect(res.data.entity.serialized).toMatchObject({ id: 'localPlayer' })

    expect(((await ask('entity', { id: 'missing' })) as any).data).toEqual({ entity: null })
    expect(await ask('entity')).toMatchObject({ ok: false, error: 'id is required' })
  })

  it('reports the network state', async () => {
    const res = await ask('network') as any
    expect(res.data.network).toEqual({ connected: true, playerId: 'socket-1', pingMs: 42, editorMode: false, pendingCommands: 3, nextSequenceId: 17 })

    delete (window as any).Game.network
    expect(((await ask('network')) as any).data.network).toBeNull()
  })

  it('has no scene until one is loaded', async () => {
    expect(((await ask('scene')) as any).data).toEqual({ scene: null })
  })

  it('serves logs after an id', async () => {
    pushLog('info', 'one')
    pushLog('error', 'two')

    const all = (await ask('logs')) as any
    expect(all.data.latestId).toBe(2)
    expect(((await ask('logs', { after: '1' })) as any).data.entries.map((e: any) => e.message)).toEqual(['two'])
  })

  it('fails without a game, and for unknown queries', async () => {
    delete (window as any).Game
    expect(await ask('status')).toMatchObject({ ok: false, error: expect.stringContaining('No game is running') })
    expect(await ask('bogus' as any)).toMatchObject({ ok: false, error: 'Unknown query bogus' })
  })
})

describe('formatArgs', () => {
  it('drops %c styles like the engine logger uses', () => {
    expect(formatArgs(['%c ERROR %c Socket error', 'color: red', 'color: grey'])).toBe('ERROR  Socket error')
    expect(formatArgs(['%c INFO %c joined', 'a', 'b', { id: 1 }])).toBe('INFO  joined {"id":1}')
  })

  it('substitutes values in order and stringifies the rest', () => {
    expect(formatArgs(['%s has %d hp', 'orc', 12])).toBe('orc has 12 hp')
    expect(formatArgs(['plain', 1, null])).toBe('plain 1 null')

    const circular: any = { a: 1 }
    circular.self = circular
    expect(formatArgs([circular])).toBe('{"a":1,"self":"[Circular]"}')
    expect(formatArgs([new Error('boom')])).toContain('Error: boom')
  })
})

describe('startDevBridge', () => {
  it('says hello, captures the console and answers requests', async () => {
    const listeners = new Map<string, (data: any) => void>()
    const sent: { event: string, data: any }[] = []
    const hot = {
      send: (event: string, data?: unknown) => void sent.push({ event, data }),
      on: (event: string, cb: (data: any) => void) => void listeners.set(event, cb),
    }
    const original = console.warn
    console.warn = vi.fn()

    try {
      startDevBridge(hot)
      expect(sent[0]).toMatchObject({ event: BRIDGE_HELLO, data: { playerId: 'socket-1' } })

      console.warn('%c WARN %c careful', 'x', 'y')
      window.dispatchEvent(new ErrorEvent('error', { error: new Error('kaput'), message: 'kaput' }))

      listeners.get(BRIDGE_REQUEST)!({ requestId: 'req-1', query: 'logs', params: {} })
      await vi.waitFor(() => expect(sent.some(s => s.event === BRIDGE_RESPONSE)).toBe(true))

      const response = sent.find(s => s.event === BRIDGE_RESPONSE)!.data
      expect(response.requestId).toBe('req-1')
      expect(response.data.entries.map((e: any) => [e.level, e.message.split('\n')[0]])).toEqual([
        ['warn', 'WARN  careful'],
        ['error', 'Uncaught Error: kaput'],
      ])
    }
    finally {
      console.warn = original
    }
  })
})
