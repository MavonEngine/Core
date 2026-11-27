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
        render: (scene: import('three').Scene) => {
          // The object being previewed is the only non light in the scene
          const object = scene.children.find(c => !(c as { isLight?: boolean }).isLight)!
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

async function load() {
  vi.resetModules()
  return (await import('../../../src/Editor/UI/Assets/primitivePreviews')).primitivePreviews
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
