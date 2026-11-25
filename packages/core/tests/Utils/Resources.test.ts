import { describe, expect, it, vi } from 'vitest'
import Resources from '../../src/Utils/Resources'

// The addons index pulls in modules Node can't import
vi.mock('three/examples/jsm/Addons.js', () => ({
  FontLoader: class { loadAsync = vi.fn() },
  SVGLoader: class { loadAsync = vi.fn() },
}))

function resources() {
  const res = new Resources([])
  const loaded = { scene: {} }
  res.loaders.gltfLoader.loadAsync = vi.fn(async (path: string) => {
    if (path.includes('missing'))
      throw new Error('404')
    return { ...loaded, path } as any
  })
  res.loaders.textureLoader.loadAsync = vi.fn(async (path: string) => ({ texture: path }) as any)
  res.loaders.cubeTextureLoader.loadAsync = vi.fn(async (paths: unknown) => ({ cube: paths }) as any)
  return res
}

describe('resources.add', () => {
  it('loads assets after the first ones and says so, without triggering loaded again', async () => {
    const res = resources()
    const added = vi.fn()
    const loaded = vi.fn()
    res.on('assetsAdded', added)
    res.on('loaded', loaded)

    await res.add([
      { name: 'tree', type: 'gltfModel', path: '/kenney/tree.glb' },
      { name: 'bark', type: 'texture', path: '/kenney/bark.png' },
      {
        name: 'sky',
        type: 'cubeTexture',
        path: ['px.png', 'nx.png'],
      },
    ])

    expect(res.items.tree).toMatchObject({ path: '/kenney/tree.glb' })
    expect(res.items.bark).toEqual({ texture: '/kenney/bark.png' })
    expect(res.items.sky).toEqual({
      cube: ['px.png', 'nx.png'],
    })
    expect(res.sources.map(source => source.name)).toEqual(['tree', 'bark', 'sky'])
    expect(added).toHaveBeenCalledWith({
      names: ['tree', 'bark', 'sky'],
    })
    expect(loaded).not.toHaveBeenCalled()
  })

  it('replaces an asset with the same name', async () => {
    const res = resources()
    await res.add([
      { name: 'tree', type: 'gltfModel', path: '/a.glb' },
    ])
    await res.add([
      { name: 'tree', type: 'gltfModel', path: '/b.glb' },
    ])

    expect(res.items.tree).toMatchObject({ path: '/b.glb' })
    expect(res.sources).toEqual([
      { name: 'tree', type: 'gltfModel', path: '/b.glb' },
    ])
  })

  it('keeps the assets that loaded and rejects naming the ones that didn\'t', async () => {
    const res = resources()
    const added = vi.fn()
    res.on('assetsAdded', added)

    await expect(res.add([
      { name: 'tree', type: 'gltfModel', path: '/tree.glb' },
      { name: 'rock', type: 'gltfModel', path: '/missing.glb' },
    ])).rejects.toThrow('Could not load rock: 404')

    expect(Object.keys(res.items)).toEqual(['tree'])
    expect(added).toHaveBeenCalledWith({
      names: ['tree'],
    })
  })
})
