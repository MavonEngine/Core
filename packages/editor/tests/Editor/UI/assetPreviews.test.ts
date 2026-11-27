import { LIGHT_REGISTRY } from '@mavonengine/core/Prefab/Lights/index'
import { PRIMITIVE_DEFINITIONS } from '@mavonengine/core/Prefab/Primitives/definitions'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const renderer = vi.hoisted(() => ({
  instances: 0,
  fail: false,
  rendered: [] as string[],
  dispose: vi.fn(),
  forceContextLoss: vi.fn(),
}))

vi.mock('three', async (importOriginal) => {
  const three = await importOriginal<typeof import('three')>()
  return {
    ...three,
    WebGLRenderer: vi.fn().mockImplementation(function () {
      if (renderer.fail)
        throw new Error('Error creating WebGL context.')
      renderer.instances++
      let current = ''
      return {
        setPixelRatio: vi.fn(),
        setSize: vi.fn(),
        setClearColor: vi.fn(),
        shadowMap: { enabled: false },
        render: (scene: import('three').Scene) => {
          // Primitives: the one object besides the lights. Lights: the one light in the scene
          const lights = scene.children.filter(c => (c as { isLight?: boolean }).isLight)
          const object = lights.length === 1
            ? lights[0]
            : scene.children.find(c => !(c as { isLight?: boolean }).isLight)!
          current = object.type
          renderer.rendered.push(current)
        },
        domElement: {
          toDataURL: () => `data:image/png;base64,${current}`,
        },
        dispose: renderer.dispose,
        forceContextLoss: renderer.forceContextLoss,
      }
    }),
  }
})

vi.mock('@mavonengine/core/Game', () => ({
  default: {
    instance: vi.fn(),
  },
}))

async function load() {
  vi.resetModules()
  return (await import('../../../src/Editor/UI/Assets/primitivePreviews')).primitivePreviews
}

async function loadLights() {
  vi.resetModules()
  return (await import('../../../src/Editor/UI/Assets/lightPreviews')).lightPreviews
}

describe('primitive previews', () => {
  beforeEach(() => {
    renderer.instances = 0
    renderer.fail = false
    renderer.rendered = []
    renderer.dispose.mockClear()
    renderer.forceContextLoss.mockClear()
  })

  it('renders every primitive once, then releases the WebGL context', async () => {
    const primitivePreviews = await load()
    const previews = primitivePreviews()

    expect([
      ...previews.keys(),
    ].sort()).toEqual(Object.keys(PRIMITIVE_DEFINITIONS).sort())
    expect([
      ...previews.values(),
    ].every(url => url.startsWith('data:image/png'))).toBe(true)
    expect(previews.get('Edges')).toContain('LineSegments')
    expect(previews.get('Box')).toContain('Mesh')
    expect(renderer.dispose).toHaveBeenCalledOnce()
    expect(renderer.forceContextLoss).toHaveBeenCalledOnce()
  })

  it('caches the images', async () => {
    const primitivePreviews = await load()
    expect(primitivePreviews()).toBe(primitivePreviews())
    expect(renderer.instances).toBe(1)
  })

  it('is empty without WebGL, so the panel falls back to its icon', async () => {
    renderer.fail = true
    const primitivePreviews = await load()
    expect(primitivePreviews().size).toBe(0)
  })
})

describe('light previews', () => {
  beforeEach(() => {
    renderer.instances = 0
    renderer.fail = false
    renderer.dispose.mockClear()
    renderer.forceContextLoss.mockClear()
  })

  it('renders every registered light, each on its own, then releases the WebGL context', async () => {
    const lightPreviews = await loadLights()
    const previews = lightPreviews()

    expect([
      ...previews.keys(),
    ].sort()).toEqual(Object.keys(LIGHT_REGISTRY).sort())
    expect(previews.get('SpotLight')).toContain('SpotLight')
    expect(previews.get('HemisphereLight')).toContain('HemisphereLight')
    expect(renderer.instances).toBe(1)
    expect(renderer.forceContextLoss).toHaveBeenCalledOnce()
  })

  it('is empty without WebGL', async () => {
    renderer.fail = true
    const lightPreviews = await loadLights()
    expect(lightPreviews().size).toBe(0)
  })
})
