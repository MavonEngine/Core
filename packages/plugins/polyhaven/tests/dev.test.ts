import type { PolyHavenContext } from '../src/dev'
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { HttpError, PolyHaven } from '../src/dev'
import { USER_AGENT } from '../src/shared'

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0))
    rmSync(dir, { recursive: true, force: true })
})

const DL = 'https://dl.polyhaven.org/file/ph-assets'

const ASSETS = {
  textures: {
    rock_wall: {
      name: 'Rock Wall',
      categories: ['rock'],
      tags: ['wall'],
      authors: { Someone: 'All' },
      download_count: 5,
    },
    brick: {
      name: 'Brick',
      categories: ['brick'],
      tags: [],
      authors: {},
      download_count: 50,
    },
  },
  models: {
    crate: {
      name: 'Crate',
      categories: ['props'],
      tags: [],
      authors: {},
      download_count: 1,
    },
  },
}

function jpg(path: string) {
  return {
    jpg: { url: `${DL}/${path}`, size: 3 },
  }
}

const FILES: Record<string, unknown> = {
  rock_wall: {
    Diffuse: {
      '1k': jpg('Textures/jpg/1k/rock_wall/rock_wall_diff_1k.jpg'),
      '2k': jpg('Textures/jpg/2k/rock_wall/rock_wall_diff_2k.jpg'),
    },
    nor_gl: {
      '1k': jpg('Textures/jpg/1k/rock_wall/rock_wall_nor_gl_1k.jpg'),
    },
    arm: {
      '1k': jpg('Textures/jpg/1k/rock_wall/rock_wall_arm_1k.jpg'),
    },
  },
  crate: {
    gltf: {
      '1k': {
        gltf: {
          url: `${DL}/Models/gltf/1k/crate/crate_1k.gltf`,
          include: {
            'crate.bin': { url: `${DL}/Models/gltf/8k/crate/crate.bin` },
            'textures/crate_diff_1k.jpg': { url: `${DL}/Models/jpg/1k/crate/crate_diff_1k.jpg` },
          },
        },
      },
    },
  },
  evil: {
    gltf: {
      '1k': {
        gltf: {
          url: `${DL}/x.gltf`,
          include: {
            '../../escape.js': { url: `${DL}/x.js` },
          },
        },
      },
    },
  },
  elsewhere: {
    Diffuse: {
      '1k': {
        jpg: { url: 'https://example.com/diff.jpg' },
      },
    },
  },
}

function setup(files = FILES) {
  const root = mkdtempSync(join(tmpdir(), 'mavonengine-polyhaven-'))
  dirs.push(root)
  let options: Record<string, unknown> = {}
  const ctx: PolyHavenContext = {
    projectRoot: root,
    publicDir: join(root, 'client', 'public'),
    dataDir: join(root, '.mavonengine', 'plugins', '@mavonengine', 'polyhaven'),
    get options() {
      return options
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    updateOptions(change) {
      const copy = structuredClone(options)
      if (change(copy) === false)
        return false
      options = copy
      return true
    },
  }
  const fetchMock = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input))
    expect(new Headers(init?.headers).get('User-Agent')).toBe(USER_AGENT)
    if (url.hostname === 'api.polyhaven.com' && url.pathname === '/assets')
      return Response.json(ASSETS[url.searchParams.get('t') as keyof typeof ASSETS])
    if (url.hostname === 'api.polyhaven.com' && url.pathname.startsWith('/files/'))
      return Response.json(files[url.pathname.slice('/files/'.length)] ?? {})
    if (url.hostname === 'cdn.polyhaven.com')
      return new Response(`thumb of ${url.pathname}`)
    if (url.hostname === 'dl.polyhaven.org')
      return new Response(`bytes of ${url.pathname.split('/').pop()}`)
    return new Response('not found', { status: 404 })
  })
  return {
    ctx,
    root,
    fetchMock,
    polyHaven: new PolyHaven(ctx, fetchMock as typeof fetch),
    options: () => options,
  }
}

const calls = (fetchMock: ReturnType<typeof vi.fn>, host: string) => fetchMock.mock.calls.filter(([url]) => String(url).includes(host)).length

describe('the asset lists', () => {
  it('are fetched once and kept in the data directory', async () => {
    const { ctx, fetchMock, polyHaven } = setup()
    const list = await polyHaven.list('textures')
    expect(list.map(asset => asset.id)).toEqual(['brick', 'rock_wall'])
    expect(list[1]).toMatchObject({
      name: 'Rock Wall',
      authors: ['Someone'],
      categories: ['rock'],
    })

    await polyHaven.list('textures')
    expect(calls(fetchMock, 'api.polyhaven.com')).toBe(1)
    expect(existsSync(join(ctx.dataDir, 'api', 'assets-textures.json'))).toBe(true)
  })

  it('fall back to the cached copy when Poly Haven is down', async () => {
    const { ctx, fetchMock, polyHaven } = setup()
    await polyHaven.list('models')
    const file = join(ctx.dataDir, 'api', 'assets-models.json')
    const old = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000)
    utimesSync(file, old, old)
    fetchMock.mockRejectedValueOnce(new Error('offline'))

    expect((await polyHaven.list('models')).map(asset => asset.id)).toEqual(['crate'])
    expect(ctx.logger.warn).toHaveBeenCalled()
  })
})

describe('thumbnails', () => {
  it('are fetched once, however many ask at the same time', async () => {
    const { fetchMock, polyHaven } = setup()
    const [a, b] = await Promise.all([
      polyHaven.thumbnail('brick'),
      polyHaven.thumbnail('brick'),
    ])
    await polyHaven.thumbnail('brick')
    expect(a).toBe(b)
    expect(readFileSync(a, 'utf8')).toBe('thumb of /asset_img/thumbs/brick.png')
    expect(calls(fetchMock, 'cdn.polyhaven.com')).toBe(1)
  })

  it('only for Poly Haven ids', async () => {
    const { polyHaven } = setup()
    await expect(polyHaven.thumbnail('../../etc/passwd')).rejects.toBeInstanceOf(HttpError)
  })
})

describe('importing', () => {
  it('a texture copies its maps into the public directory, makes a graph and records it', async () => {
    const { ctx, root, polyHaven, options } = setup()
    const imported = await polyHaven.import('rock_wall', 'textures', '2k')

    // The base color at 2k, the other maps at the largest below it they have
    expect(imported).toMatchObject({
      id: 'rock_wall',
      resolution: '2k',
      graph: 'polyhaven_rock_wall',
      graphCreated: true,
      files: {
        diff: '/polyhaven/rock_wall/rock_wall_diff_2k.jpg',
        nor: '/polyhaven/rock_wall/rock_wall_nor_gl_1k.jpg',
        arm: '/polyhaven/rock_wall/rock_wall_arm_1k.jpg',
      },
    })
    expect(readFileSync(join(ctx.publicDir, 'polyhaven/rock_wall/rock_wall_diff_2k.jpg'), 'utf8')).toBe('bytes of rock_wall_diff_2k.jpg')
    expect(existsSync(join(ctx.dataDir, 'downloads', 'rock_wall', '2k', 'rock_wall_diff_2k.jpg'))).toBe(true)

    const graph = JSON.parse(readFileSync(join(root, 'graphs', 'polyhaven_rock_wall.graph.json'), 'utf8'))
    expect(graph).toMatchObject({ kind: 'material', name: 'polyhaven_rock_wall' })

    const { graphCreated: _, ...recorded } = imported
    expect(options().imported).toEqual([recorded])
  })

  it('again keeps an edited graph, replaces the files and downloads nothing it has', async () => {
    const { root, ctx, fetchMock, polyHaven, options } = setup()
    await polyHaven.import('rock_wall', 'textures', '2k')
    const graphFile = join(root, 'graphs', 'polyhaven_rock_wall.graph.json')
    const { writeFileSync } = await import('node:fs')
    writeFileSync(graphFile, '{"edited":true}')
    const downloads = calls(fetchMock, 'dl.polyhaven.org')

    const again = await polyHaven.import('rock_wall', 'textures', '1k')
    expect(again.graphCreated).toBe(false)
    expect(readFileSync(graphFile, 'utf8')).toBe('{"edited":true}')
    expect(existsSync(join(ctx.publicDir, 'polyhaven/rock_wall/rock_wall_diff_2k.jpg'))).toBe(false)
    expect(existsSync(join(ctx.publicDir, 'polyhaven/rock_wall/rock_wall_diff_1k.jpg'))).toBe(true)
    // Only the 1k base color is new
    expect(calls(fetchMock, 'dl.polyhaven.org')).toBe(downloads + 1)
    expect((options().imported as unknown[]).length).toBe(1)
  })

  it('a model copies the glTF with what it includes, at their paths', async () => {
    const { ctx, polyHaven } = setup()
    const imported = await polyHaven.import('crate', 'models', '4k')
    expect(imported).toMatchObject({
      resolution: '1k',
      files: { gltf: '/polyhaven/crate/crate_1k.gltf' },
    })
    expect(imported.graph).toBeUndefined()
    for (const file of ['crate_1k.gltf', 'crate.bin', 'textures/crate_diff_1k.jpg'])
      expect(existsSync(join(ctx.publicDir, 'polyhaven/crate', file))).toBe(true)
  })

  it('refuses files outside the asset\'s directory or from another host', async () => {
    const { root, polyHaven } = setup()
    ;(ASSETS.models as Record<string, unknown>).evil = { name: 'Evil' }
    ;(ASSETS.textures as Record<string, unknown>).elsewhere = { name: 'Elsewhere' }
    try {
      await expect(polyHaven.import('evil', 'models', '1k')).rejects.toThrow(/outside/)
      await expect(polyHaven.import('elsewhere', 'textures', '1k')).rejects.toThrow(/only come from dl.polyhaven.org/)
      expect(existsSync(join(root, 'escape.js'))).toBe(false)
    }
    finally {
      delete (ASSETS.models as Record<string, unknown>).evil
      delete (ASSETS.textures as Record<string, unknown>).elsewhere
    }
  })

  it('turns away what isn\'t an asset', async () => {
    const { polyHaven } = setup()
    await expect(polyHaven.import('nope', 'textures', '1k')).rejects.toMatchObject({ status: 404 })
    await expect(polyHaven.import('brick', 'hdris' as 'textures', '1k')).rejects.toMatchObject({ status: 400 })
    await expect(polyHaven.import('brick', 'textures', '16k' as '1k')).rejects.toMatchObject({ status: 400 })
  })
})
