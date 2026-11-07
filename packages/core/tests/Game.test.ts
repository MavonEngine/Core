// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import Game from '../src/Game'
import { getPrefab, unregisterPrefab } from '../src/Prefab/PrefabRegistry'
import Resources from '../src/Utils/Resources'

vi.mock('three', async () => {
  const actual = await vi.importActual<typeof import('three')>('three')
  return {
    ...actual,
    Clock: vi.fn().mockImplementation(function () {
      return {
        start: vi.fn(),
        getDelta: vi.fn().mockReturnValue(0.016),
      }
    }),
    Audio: vi.fn().mockImplementation(function () { return { listener: {} } }),
    AudioListener: vi.fn().mockImplementation(function () { return {} }),
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
const mockInputManager = { update: vi.fn() }
const mockClientGameWorld = { update: vi.fn(), entities: { items: new Map() } }

vi.mock('../src/Camera', () => ({
  default: vi.fn(function () {
    return mockCamera
  }),
}))
vi.mock('../src/Renderer', () => ({
  default: vi.fn(function () {
    return mockRenderer
  }),
}))
vi.mock('../src/Utils/Resources', () => ({
  default: vi.fn(function () {
    return mockResources
  }),
}))
vi.mock('../src/Utils/Sizes', () => ({
  default: vi.fn(function () {
    return mockSizes
  }),
}))
vi.mock('../src/Utils/Debug', () => ({
  default: vi.fn(function () {
    return mockDebug
  }),
}))
vi.mock('../src/Utils/LoadingScreen', () => ({
  default: vi.fn(function () {
    return mockLoadingScreen
  }),
}))
vi.mock('../src/Utils/Logger', () => ({
  default: vi.fn(function () {
    return mockLogger
  }),
}))
vi.mock('../src/Particles/System/ParticleSystem', () => ({
  default: vi.fn(function () {
    return mockParticleSystem
  }),
}))
vi.mock('../src/InputManager', () => ({
  default: vi.fn(function () {
    return mockInputManager
  }),
}))
vi.mock('../src/World/World', () => ({
  default: vi.fn(function () {
    return mockClientGameWorld
  }),
}))
vi.mock('../src/Renderer/PhysicsRenderer', () => ({
  RapierDebugRenderer: vi.fn(function () { return { update: vi.fn() } }),
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

  describe('plugins', () => {
    afterEach(() => {
      Game.usePlugins([])
    })

    it('loads plugin assets with the game, from /plugins/<package>/', () => {
      Game.usePlugins([{
        package: 'forest',
        options: {},
        plugin: { assets: ctx => [{ name: 'tree', type: 'gltfModel', path: ctx.assetUrl('/models/tree.glb') }] },
      }])

      void new Game([{ name: 'pine', type: 'gltfModel', path: '/pine.glb' }])

      expect(vi.mocked(Resources)).toHaveBeenLastCalledWith([
        { name: 'pine', type: 'gltfModel', path: '/pine.glb' },
        { name: 'tree', type: 'gltfModel', path: '/plugins/forest/models/tree.glb' },
      ])
    })

    it('skips assets left out of the release', () => {
      Game.usePlugins([{
        package: 'forest',
        options: {},
        shippedAssets: ['models/tree.glb'],
        plugin: {
          assets: ctx => [
            { name: 'tree', type: 'gltfModel', path: ctx.assetUrl('models/tree.glb') },
            { name: 'rock', type: 'gltfModel', path: ctx.assetUrl('models/rock.glb') },
            { name: 'sky', type: 'cubeTexture', path: ['/sky/px.png'] },
          ],
        },
      }])

      void new Game([])

      expect(vi.mocked(Resources).mock.lastCall![0].map(a => a.name)).toEqual(['tree', 'sky'])
    })

    it('sets plugins up once the world exists and updates them every frame', () => {
      const setup = vi.fn()
      const update = vi.fn()
      Game.usePlugins([{ name: 'hud', setup, update }])

      const game = new Game([])
      game.update(0.016)

      expect(setup).toHaveBeenCalledWith(expect.objectContaining({ package: 'hud', game }))
      expect(update).toHaveBeenCalledWith(0.016, expect.anything())
    })

    it('registers plugin prefabs under the plugin', () => {
      Game.usePlugins([{ package: 'forest', options: {}, plugin: { setup: ctx => ctx.registerPrefab({ name: 'Tree', spawn: vi.fn() }) } }])

      void new Game([])

      expect(getPrefab('forest:Tree')?.plugin).toBe('forest')
      unregisterPrefab('forest:Tree')
    })

    it('runs the editor hook when the editor boots', () => {
      const editorHook = vi.fn()
      Game.usePlugins([{ editor: editorHook }])
      const game = new Game([])
      const editor = { update: vi.fn() } as any

      game.editor = editor
      game.trigger('editorBoot', editor)

      expect(editorHook).toHaveBeenCalledWith(expect.objectContaining({ editor }))
    })
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

  it('update() polls input before updating the world', () => {
    const game = new Game([])
    game.update(0.016)
    expect(mockInputManager.update).toHaveBeenCalled()
    expect(mockInputManager.update.mock.invocationCallOrder[0])
      .toBeLessThan(mockClientGameWorld.update.mock.invocationCallOrder[0])
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
