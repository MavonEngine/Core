import { Mesh, MeshBasicMaterial, SphereGeometry } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { MaterialGraphLibrary } from '../../src/Graph/Material/MaterialGraphs'
import { parseGraphData } from '../../src/Graph/types'

vi.mock('../../src/Game', () => ({
  default: {
    instance: () => ({
      resources: { items: {} },
      resourcesReady: async () => {},
    }),
  },
}))

function graph(color: number[]) {
  return parseGraphData({
    kind: 'material',
    name: 'lava',
    nodes: [
      { id: 'out', type: 'material.output' },
      {
        id: 'c',
        type: 'input.color',
        values: { value: color },
      },
    ],
    edges: [
      {
        from: { node: 'c', port: 'value' },
        to: { node: 'out', port: 'color' },
      },
    ],
  })
}

describe('materialGraphLibrary', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('loads a graph by name once and shares its material between meshes', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(graph([1, 0, 0]))))
    vi.stubGlobal('fetch', fetch)
    const library = new MaterialGraphLibrary()
    const a = new Mesh(new SphereGeometry(), new MeshBasicMaterial())
    const b = new Mesh(new SphereGeometry(), new MeshBasicMaterial())

    const [ma, mb] = await Promise.all([
      library.apply(a, 'lava'),
      library.apply(b, 'lava'),
    ])

    expect(fetch).toHaveBeenCalledTimes(1)
    expect(fetch).toHaveBeenCalledWith('/graphs/lava.graph.json', { cache: 'no-store' })
    expect(ma).toBe(mb)
    expect(a.material).toBe(ma)
    expect(library.graphOf(a)).toBe('lava')
  })

  it('puts a changed graph on every mesh using it, but not on released ones', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(graph([1, 0, 0])))))
    const library = new MaterialGraphLibrary()
    const used = new Mesh()
    const released = new Mesh()
    const old = await library.apply(used, 'lava')
    await library.apply(released, 'lava')
    library.release(released)
    const dispose = vi.spyOn(old, 'dispose')
    const changed = vi.fn()
    library.subscribe(changed)

    const { material } = library.set('lava', graph([0, 0, 1]))

    expect(used.material).toBe(material)
    expect(released.material).toBe(old)
    expect(dispose).toHaveBeenCalled()
    expect(changed).toHaveBeenCalled()
  })

  it('leaves the mesh as it was when the graph doesn\'t load', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 404, statusText: 'Not Found' })))
    const library = new MaterialGraphLibrary()
    const own = new MeshBasicMaterial()
    const mesh = new Mesh(new SphereGeometry(), own)

    await expect(library.apply(mesh, 'missing')).rejects.toThrow('404 Not Found')
    expect(mesh.material).toBe(own)
    expect(library.graphOf(mesh)).toBeUndefined()
  })
})
