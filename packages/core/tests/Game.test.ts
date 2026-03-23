// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Game from '../src/Game'

vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three')
  return {
    ...actual,
    Clock: vi.fn().mockImplementation(() => ({
      start: vi.fn(),
      getDelta: vi.fn().mockReturnValue(0.016),
    })),
    Audio: vi.fn().mockImplementation(() => ({ listener: {} })),
    AudioListener: vi.fn().mockImplementation(() => ({})),
  }
})

const mockCamera = { resize: vi.fn(), update: vi.fn() }
const mockRenderer = { resize: vi.fn(), update: vi.fn() }
const mockResources = {}
const mockSizes = { on: vi.fn() }
const mockDebug = {}
const mockLoadingScreen = { update: vi.fn() }
const mockLogger = { info: vi.fn(), debug: vi.fn(), error: vi.fn(), emerg: vi.fn() }
const mockParticleSystem = { update: vi.fn() }
const mockInputManager = {}
const mockClientGameWorld = { update: vi.fn(), entities: { items: new Map() } }

vi.mock('../src/Camera', () => ({ default: vi.fn(() => mockCamera) }))
vi.mock('../src/Renderer', () => ({ default: vi.fn(() => mockRenderer) }))
vi.mock('../src/Utils/Resources', () => ({ default: vi.fn(() => mockResources) }))
vi.mock('../src/Utils/Sizes', () => ({ default: vi.fn(() => mockSizes) }))
vi.mock('../src/Utils/Debug', () => ({ default: vi.fn(() => mockDebug) }))
vi.mock('../src/Utils/LoadingScreen', () => ({ default: vi.fn(() => mockLoadingScreen) }))
vi.mock('../src/Utils/Logger', () => ({ default: vi.fn(() => mockLogger) }))
vi.mock('../src/Particles/System/ParticleSystem', () => ({ default: vi.fn(() => mockParticleSystem) }))
vi.mock('../src/InputManager', () => ({ default: vi.fn(() => mockInputManager) }))
vi.mock('../src/World/World', () => ({ default: vi.fn(() => mockClientGameWorld) }))
vi.mock('../src/Renderer/PhysicsRenderer', () => ({
  RapierDebugRenderer: vi.fn(() => ({ update: vi.fn() })),
}))
vi.mock('../src/Editor', () => ({
  default: { registerListener: vi.fn() },
}))

describe('game', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('requestAnimationFrame', vi.fn())
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.unstubAllGlobals()
  })

  it('initializes all subsystems on construction', () => {
    const game = new Game([])
    expect(game.camera).toBeDefined()
    expect(game.renderer).toBeDefined()
    expect(game.resources).toBeDefined()
    expect(game.sizes).toBeDefined()
    expect(game.input).toBeDefined()
    expect(game.particleSystem).toBeDefined()
    expect(game.loadingScreen).toBeDefined()
    expect(game.world).toBeDefined()
  })

  it('appends canvas to document body', () => {
    const game = new Game([])
    expect(document.body.contains(game.canvas)).toBe(true)
  })

  it('inserts uiRoot div into the document', () => {
    const game = new Game([])
    expect(document.getElementById('ui')).not.toBeNull()
    expect(game.uiRoot.id).toBe('ui')
  })

  it('canvas has draggable=false set', () => {
    const game = new Game([])
    expect(game.canvas.getAttribute('draggable')).toBe('false')
  })

  it('instance() returns the Game singleton', () => {
    const game = new Game([])
    expect(Game.instance()).toBe(game)
  })

  it('update() calls loadingScreen.update and camera.update with delta', () => {
    const game = new Game([])
    game.update(0.016)
    expect(mockLoadingScreen.update).toHaveBeenCalledWith(0.016)
    expect(mockCamera.update).toHaveBeenCalledWith(0.016)
  })

  it('update() calls editor.update when editor is set', () => {
    const game = new Game([])
    const mockEditor = { update: vi.fn() }
    ;(game as any).editor = mockEditor
    game.update(0.016)
    expect(mockEditor.update).toHaveBeenCalledWith(0.016)
  })

  it('resize() propagates to camera and renderer', () => {
    const game = new Game([])
    ;(game as any).resize()
    expect(mockCamera.resize).toHaveBeenCalled()
    expect(mockRenderer.resize).toHaveBeenCalled()
  })

  it('fires resize when sizes emits resize event', () => {
    const _game = new Game([])
    const [event, handler] = mockSizes.on.mock.calls[0]
    expect(event).toBe('resize')
    handler()
    expect(mockCamera.resize).toHaveBeenCalled()
    expect(mockRenderer.resize).toHaveBeenCalled()
  })
})
