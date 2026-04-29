// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import EventEmitter from '../../src/Utils/EventEmitter'
import LoadingScreen from '../../src/Utils/LoadingScreen'

vi.mock('../../src/Particles/Shaders/LoadingScreen/Fragment.glsl', () => ({ default: '' }))
vi.mock('../../src/Particles/Shaders/LoadingScreen/Vertex.glsl', () => ({ default: '' }))

vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three')
  return {
    ...actual,
    PlaneGeometry: vi.fn(),
    ShaderMaterial: vi.fn().mockImplementation(({ uniforms }: any) => ({ uniforms })),
    Mesh: vi.fn().mockImplementation((_geo: any, material: any) => ({ material })),
  }
})

const mockScene = { add: vi.fn(), remove: vi.fn() }
const mockUiRoot = { style: { opacity: '0', removeProperty: vi.fn() } }
const gameListeners: Record<string, (...args: any[]) => void> = {}
const mockGame = {
  on: vi.fn((event: string, cb: (...args: any[]) => void) => { gameListeners[event] = cb }),
  scene: mockScene,
  uiRoot: mockUiRoot,
}

vi.mock('../../src/Game', () => ({
  default: { instance: vi.fn(() => mockGame) },
}))

describe('loadingScreen', () => {
  let resources: EventEmitter
  let loadingBar: HTMLDivElement
  let loadingScreen: LoadingScreen

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    Object.keys(gameListeners).forEach(k => delete gameListeners[k])

    loadingBar = document.createElement('div')
    loadingBar.id = 'loadingBar'
    document.body.appendChild(loadingBar)

    resources = new EventEmitter()
    loadingScreen = new LoadingScreen(resources as any)
    gameListeners.uiMounted?.()
  })

  afterEach(() => {
    document.body.innerHTML = ''
    vi.useRealTimers()
  })

  it('does nothing in update() before resources are loaded', () => {
    loadingScreen.update(0.016)
    expect(mockScene.remove).not.toHaveBeenCalled()
    expect(loadingScreen.progress).toBe(0)
  })

  it('sets loaded=true when resources emit loaded', () => {
    resources.trigger('loaded')
    expect(loadingScreen.loaded).toBe(true)
  })

  it('updates loadingBar transform on progress event', () => {
    resources.trigger('progress', { loaded: 1, total: 4 })
    expect(loadingBar.style.transform).toBe('scaleX(0.25)')
  })

  it('adds ended class and removes visibility after 500ms on loaded', () => {
    resources.trigger('loaded')
    vi.advanceTimersByTime(500)
    expect(loadingBar.classList.contains('ended')).toBe(true)
    expect(mockUiRoot.style.removeProperty).toHaveBeenCalledWith('visibility')
  })

  it('fades the overlay during update() after loading', () => {
    resources.trigger('loaded')
    loadingScreen.update(1) // 1s into a 2s fade
    expect(loadingScreen.progress).toBeGreaterThan(0)
    expect(loadingScreen.progress).toBeLessThan(1)
  })

  it('emits finished, sets finished flag, removes overlay, and zeroes progress when fade completes', () => {
    resources.trigger('loaded')
    const onFinished = vi.fn()
    loadingScreen.on('finished', onFinished)
    loadingScreen.update(3) // past the 2s duration
    expect(onFinished).toHaveBeenCalledOnce()
    expect(loadingScreen.finished).toBe(true)
    expect(mockScene.remove).toHaveBeenCalled()
    expect(loadingScreen.progress).toBe(0)
  })

  it('does not emit finished or remove overlay more than once', () => {
    resources.trigger('loaded')
    loadingScreen.update(3)
    loadingScreen.update(1) // extra update after completion
    expect(mockScene.remove).toHaveBeenCalledOnce()
  })
})
