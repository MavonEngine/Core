// @vitest-environment jsdom

import type { ServerEntityView } from '@mavonengine/core/Networking/Client/NetworkManager'
import type { SyncSnapshot } from '@mavonengine/core/Networking/Debug/sync'
import Game from '@mavonengine/core/Game'
import { Scene, Vector3 } from 'three'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import NetworkOverlay, { ghostState } from '../../../src/Editor/Network/NetworkOverlay'
import SyncStore from '../../../src/Editor/Network/SyncStore'

// The real Game pulls in the renderer, which needs a canvas
vi.mock('@mavonengine/core/Game', () => ({ default: { instance: vi.fn() } }))

const at = (x: number) => ({ x, y: 0, z: 0 })

function view(id: string, x: number, tick: number, receivedAt = performance.now()): ServerEntityView {
  return { id, type: 'rock', position: at(x), rotation: at(0), scale: { x: 1, y: 1, z: 1 }, tick, receivedAt }
}

function snapshot(overrides: Partial<SyncSnapshot> = {}): SyncSnapshot {
  return {
    tick: 10,
    serverTime: 0,
    tickRate: 30,
    syncDistance: 50,
    players: [
      { id: 'p1', displayName: 'Ada', position: at(0), ack: 0, tracked: ['p1', 'rock'], lastState: null },
      { id: 'p2', displayName: 'Bob', position: at(200), ack: 0, tracked: ['p2'], lastState: null },
    ],
    editors: [],
    entities: [
      { id: 'rock', type: 'rock', position: at(1), rotation: at(0), scale: at(1), player: false, needsSync: false, trackedBy: 1, lastSentTick: 10 },
      { id: 'tree', type: 'tree', position: at(900), rotation: at(0), scale: at(1), player: false, needsSync: false, trackedBy: 0, lastSentTick: null },
    ],
    ...overrides,
  }
}

describe('ghostState', () => {
  it('goes by what this client received when the server\'s sync is unknown', () => {
    expect(ghostState(view('rock', 0, 10), 10)).toBe('synced')
    expect(ghostState(view('rock', 0, 9), 10)).toBe('synced')
    expect(ghostState(view('rock', 0, 5), 10)).toBe('stale')
    expect(ghostState(view('rock', 0, 5), null)).toBe('synced')
  })

  it('marks entities no player is sent', () => {
    expect(ghostState(view('tree', 0, 10), 10, snapshot())).toBe('untracked')
    expect(ghostState(view('rock', 0, 10), 10, snapshot())).toBe('synced')
    // Without players nothing is tracked, which says nothing about the entity
    expect(ghostState(view('tree', 0, 10), 10, snapshot({ players: [] }))).toBe('synced')
  })

  it('goes by one player when viewing as it', () => {
    expect(ghostState(view('rock', 0, 10), 10, snapshot(), 'p1')).toBe('synced')
    expect(ghostState(view('rock', 0, 10), 10, snapshot(), 'p2')).toBe('untracked')
    expect(ghostState(view('p2', 0, 10), 10, snapshot(), 'p2')).toBe('synced')
    // A player that left: back to everyone's view
    expect(ghostState(view('rock', 0, 10), 10, snapshot(), 'gone')).toBe('synced')
  })
})

describe('networkOverlay', () => {
  let scene: Scene
  let serverView: { tick: number | null, entities: Map<string, ServerEntityView> }
  let entities: Map<string, { position: Vector3 }>
  let sync: SyncStore

  beforeEach(() => {
    localStorage.clear()
    scene = new Scene()
    serverView = { tick: 10, entities: new Map() }
    entities = new Map()
    vi.mocked(Game.instance).mockReturnValue({ scene, network: { serverView }, world: { entities: { items: entities } } } as any)
    sync = new SyncStore(1000, async () => snapshot())
  })

  it('stays out of the scene and asks nothing until something is switched on', () => {
    const load = vi.fn(async () => snapshot())
    const overlay = new NetworkOverlay(new SyncStore(1000, load))
    overlay.update()

    expect(scene.children).toHaveLength(0)
    expect(load).not.toHaveBeenCalled()

    overlay.setOptions({ ghosts: true })
    expect(scene.children).toEqual([overlay.group])
    expect(overlay.group.userData.isEditorInternal).toBe(true)
    expect(load).toHaveBeenCalledTimes(1)

    overlay.setOptions({ ghosts: false })
    expect(scene.children).toHaveLength(0)
    overlay.dispose()
  })

  it('draws a ghost where the server said the entity is, with a line to where it is rendered', () => {
    const overlay = new NetworkOverlay(sync, { ghosts: true, rings: false, viewAs: null })
    serverView.entities.set('rock', view('rock', 4, 10))
    entities.set('rock', { position: new Vector3(4, 0, 0) })

    overlay.update()

    const ghost = overlay.group.getObjectByName('ServerGhost:rock')!
    expect(ghost.position.x).toBe(4)
    const line = overlay.group.children.find(child => child !== ghost)!
    expect(line.visible).toBe(false)

    // The client renders it somewhere else than the server has it
    entities.get('rock')!.position.set(6, 0, 0)
    overlay.update()
    expect(line.visible).toBe(true)
    expect(Array.from((line as any).geometry.getAttribute('position').array)).toEqual([4, 0, 0, 6, 0, 0])

    // Nothing in the overlay can be picked in the viewport
    const hits: unknown[] = []
    ;(ghost as any).raycast({}, hits)
    expect(hits).toEqual([])
    overlay.dispose()
  })

  it('colours ghosts by their sync state and removes ghosts of entities that are gone', async () => {
    const overlay = new NetworkOverlay(sync, { ghosts: true, rings: false, viewAs: null })
    await sync.refresh()
    serverView.entities.set('rock', view('rock', 1, 10))
    serverView.entities.set('tree', view('tree', 900, 10))
    entities.set('rock', { position: new Vector3(1, 0, 0) })
    entities.set('tree', { position: new Vector3(900, 0, 0) })

    overlay.update()
    const color = (id: string) => (overlay.group.getObjectByName(`ServerGhost:${id}`) as any).material.color.getHex()
    expect(color('rock')).toBe(0x4EC9B0)
    expect(color('tree')).toBe(0x888888)

    overlay.setOptions({ viewAs: 'p2' })
    overlay.update()
    expect(color('rock')).toBe(0x888888)

    // Removed on the client and not heard of for a while
    entities.delete('tree')
    serverView.entities.set('tree', view('tree', 900, 3, performance.now() - 5000))
    overlay.update()
    expect(overlay.counts.ghosts).toBe(1)
    expect(overlay.group.getObjectByName('ServerGhost:tree')).toBeUndefined()
    overlay.dispose()
  })

  it('draws a ring of the sync distance around each player', async () => {
    const overlay = new NetworkOverlay(sync, { ghosts: false, rings: true, viewAs: 'p2' })
    await sync.refresh()

    overlay.update()

    expect(overlay.counts).toEqual({ ghosts: 0, rings: 2 })
    const ring = overlay.group.getObjectByName('SyncRing:p2')!
    expect(ring.position.x).toBe(200)
    expect(ring.scale.x).toBe(50)
    expect((ring as any).material.color.getHex()).toBe(0xFFFFFF)
    expect((overlay.group.getObjectByName('SyncRing:p1') as any).material.color.getHex()).toBe(0x007ACC)

    overlay.setOptions({ rings: false, ghosts: true })
    overlay.update()
    expect(overlay.counts.rings).toBe(0)
    overlay.dispose()
  })

  it('remembers what was switched on, and tells listeners', () => {
    const overlay = new NetworkOverlay(sync)
    const changed = vi.fn()
    overlay.on('changed', changed)

    overlay.setOptions({ rings: true, viewAs: 'p1' })

    expect(changed).toHaveBeenCalledWith({ ghosts: false, rings: true, viewAs: 'p1' })
    overlay.dispose()

    // The viewed player is not remembered: it may be gone next time
    const next = new NetworkOverlay(sync)
    expect(next.options).toEqual({ ghosts: false, rings: true, viewAs: null })
    next.dispose()
  })
})

describe('syncStore', () => {
  it('asks while something listens and keeps the last answer', async () => {
    vi.useFakeTimers()
    const load = vi.fn(async () => snapshot())
    const store = new SyncStore(250, load)
    const listener = vi.fn()

    const unsubscribe = store.subscribe(listener)
    await vi.advanceTimersByTimeAsync(0)
    expect(store.get().sync?.tick).toBe(10)
    expect(listener).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(500)
    expect(load).toHaveBeenCalledTimes(3)

    unsubscribe()
    await vi.advanceTimersByTimeAsync(1000)
    expect(load).toHaveBeenCalledTimes(3)
    vi.useRealTimers()
  })

  it('reports why the server could not be asked, once', async () => {
    const store = new SyncStore(250, async () => {
      throw new Error('The game server is not reachable')
    })
    const listener = vi.fn()
    store.subscribe(listener)()

    await store.refresh()
    await store.refresh()

    expect(store.get()).toEqual({ error: 'The game server is not reachable' })
    expect(listener).not.toHaveBeenCalled()
  })
})
