import type { DevMiddleware, DevPluginContext } from '@mavonengine/core/Plugins/types'
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { AssetKind, ImportedAsset, PolyHavenAsset, Resolution, TextureMap } from './shared'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import process from 'node:process'
import { readBody } from '@mavonengine/core/Plugins/devRequest'
import { resolveInside } from '@mavonengine/core/Plugins/ProjectConfig'
import { defineDevPlugin } from '@mavonengine/core/Plugins/types'
import {
  API_BASE,
  ASSET_KINDS,
  DOWNLOAD_HOSTS,
  graphName,
  ID_RE,
  importedAssets,
  publicPath,
  RESOLUTIONS,
  TEXTURE_MAPS,
  textureGraph,
  thumbnailUrl,
  USER_AGENT,
} from './shared'

/*
 * The plugin's dev entry, in the client's Vite dev server. The editor's panel only ever talks to this, never to Poly
 * Haven: it fetches the asset lists, thumbnails and files once and keeps them in `.mavonengine/plugins/<package>/`,
 * and on import copies the files into the client's public directory, where they become part of the game.
 */

/** How long the asset lists and file lists are used before asking Poly Haven again */
const LIST_TTL_MS = 24 * 60 * 60 * 1000
const REQUEST_TIMEOUT_MS = 20_000
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000

/** A file of an asset as `/files/<id>` describes it, the part used here */
interface RemoteFile {
  url: string
  size?: number
  include?: Record<string, RemoteFile>
}
type FileTree = Record<string, Record<string, Record<string, RemoteFile>>>

interface RawAsset {
  name?: string
  categories?: string[]
  tags?: string[]
  authors?: Record<string, string>
  max_resolution?: number[]
  download_count?: number
  date_published?: number
}

export class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

/** The part of the dev context this uses, so tests can make one */
export type PolyHavenContext = Pick<DevPluginContext, 'dataDir' | 'publicDir' | 'projectRoot' | 'options' | 'logger' | 'updateOptions'>

function writeAtomic(file: string, data: string | Uint8Array) {
  mkdirSync(dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  writeFileSync(temp, data)
  renameSync(temp, file)
}

/** Poly Haven, through the plugin's cache in its data directory */
export class PolyHaven {
  /** Thumbnails and downloads under way, so the same file is fetched once however many ask for it */
  private pending = new Map<string, Promise<void>>()

  constructor(private readonly ctx: PolyHavenContext, private readonly fetchImpl: typeof fetch = fetch) {}

  private cacheFile(...parts: string[]): string {
    return join(this.ctx.dataDir, ...parts)
  }

  private async request(url: string, timeout = REQUEST_TIMEOUT_MS): Promise<Response> {
    let res: Response
    try {
      res = await this.fetchImpl(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(timeout),
      })
    }
    catch (err) {
      throw new HttpError(502, `Poly Haven can't be reached: ${(err as Error).message}`)
    }
    if (!res.ok) {
      throw new HttpError(res.status === 404
        ? 404
        : 502, `Poly Haven answered ${res.status} for ${url}`)
    }
    return res
  }

  /** JSON from the API, kept in `file` for a day. When Poly Haven can't be reached, what was kept, however old */
  private async cachedJson<T>(path: string, file: string): Promise<T> {
    const fresh = existsSync(file) && Date.now() - statSync(file).mtimeMs < LIST_TTL_MS
    if (!fresh) {
      try {
        const text = await (await this.request(`${API_BASE}${path}`)).text()
        JSON.parse(text)
        writeAtomic(file, text)
      }
      catch (err) {
        if (!existsSync(file))
          throw err
        this.ctx.logger.warn(`Poly Haven: using the cached ${path}, ${(err as Error).message}`)
      }
    }
    return JSON.parse(readFileSync(file, 'utf8')) as T
  }

  /** Every asset of a kind, most downloaded first */
  async list(kind: AssetKind): Promise<PolyHavenAsset[]> {
    const raw = await this.cachedJson<Record<string, RawAsset>>(`/assets?t=${kind}`, this.cacheFile('api', `assets-${kind}.json`))
    return Object.entries(raw)
      .filter(([id]) => ID_RE.test(id))
      .map(([id, asset]) => ({
        id,
        name: asset.name ?? id,
        categories: asset.categories ?? [],
        tags: asset.tags ?? [],
        authors: Object.keys(asset.authors ?? {}),
        maxResolution: asset.max_resolution?.[0],
        downloads: asset.download_count ?? 0,
        published: asset.date_published ?? 0,
      }))
      .sort((a, b) => b.downloads - a.downloads)
  }

  private files(id: string): Promise<FileTree> {
    return this.cachedJson<FileTree>(`/files/${id}`, this.cacheFile('api', 'files', `${id}.json`))
  }

  /** Fetch `url` into `file` once, unless it is there already */
  private fetchOnce(url: string, file: string, timeout = DOWNLOAD_TIMEOUT_MS): Promise<void> {
    if (existsSync(file))
      return Promise.resolve()
    let pending = this.pending.get(file)
    if (!pending) {
      pending = (async () => {
        const res = await this.request(url, timeout)
        writeAtomic(file, new Uint8Array(await res.arrayBuffer()))
      })().finally(() => this.pending.delete(file))
      this.pending.set(file, pending)
    }
    return pending
  }

  /** The thumbnail of an asset, from the cache, fetched on first ask */
  async thumbnail(id: string): Promise<string> {
    if (!ID_RE.test(id))
      throw new HttpError(400, `Not a Poly Haven id: ${id}`)
    const file = this.cacheFile('thumbs', `${id}.png`)
    await this.fetchOnce(thumbnailUrl(id), file, REQUEST_TIMEOUT_MS)
    return file
  }

  /** A file of an asset, downloaded once into the cache. Only from Poly Haven's download host */
  private async download(id: string, resolution: Resolution, remote: RemoteFile, path: string): Promise<string> {
    let url: URL
    try {
      url = new URL(remote.url)
    }
    catch {
      throw new HttpError(502, `Poly Haven listed a file without a valid URL for ${id}`)
    }
    if (url.protocol !== 'https:' || !DOWNLOAD_HOSTS.includes(url.hostname))
      throw new HttpError(502, `Not downloading ${url.href}: files only come from ${DOWNLOAD_HOSTS.join(', ')}`)

    const base = this.cacheFile('downloads', id, resolution)
    const file = resolveInside(base, path)
    if (!file)
      throw new HttpError(502, `Poly Haven listed a file outside the asset's directory: ${path}`)
    await this.fetchOnce(url.href, file)
    return file
  }

  /**
   * Import an asset: download its files at `resolution` (or the closest smaller one it has), put them in the public
   * directory, make a material graph for a texture, and record it in the options. Importing again replaces the files
   * but keeps a graph that is already there, which may have been edited.
   */
  async import(id: string, kind: AssetKind, wanted: Resolution): Promise<ImportedAsset & { graphCreated?: boolean }> {
    if (!ID_RE.test(id))
      throw new HttpError(400, `Not a Poly Haven id: ${id}`)
    if (!ASSET_KINDS.includes(kind))
      throw new HttpError(400, `Can't import ${kind}, only ${ASSET_KINDS.join(' and ')}`)
    if (!RESOLUTIONS.includes(wanted))
      throw new HttpError(400, `Not a resolution: ${wanted}`)

    const listed = (await this.list(kind)).find(asset => asset.id === id)
    if (!listed)
      throw new HttpError(404, `Poly Haven has no ${kind.slice(0, -1)} ${id}`)

    const tree = await this.files(id)
    // The first of the wanted resolution and the smaller ones that the asset has
    const pick = <T>(byResolution: Record<string, T> | undefined): [Resolution, T] | undefined => {
      for (const resolution of RESOLUTIONS.slice(0, RESOLUTIONS.indexOf(wanted) + 1).reverse()) {
        if (byResolution?.[resolution])
          return [resolution, byResolution[resolution]]
      }
      return undefined
    }

    // Files to copy into the public directory: [path there, cached file]
    const copies: [string, string][] = []
    const entry: ImportedAsset = {
      id,
      kind,
      name: listed.name,
      resolution: wanted,
      files: {},
    }
    const urlOf = (path: string) => `/${publicPath(id)}/${path}`

    if (kind === 'textures') {
      const maps = (Object.keys(TEXTURE_MAPS) as TextureMap[]).flatMap((map) => {
        const found = pick(tree[TEXTURE_MAPS[map]])
        const jpg = found?.[1].jpg
        return jpg
          ? [
              { map, resolution: found![0], jpg },
            ]
          : []
      })
      if (!maps.some(({ map }) => map === 'diff'))
        throw new HttpError(502, `Poly Haven has no base color of ${id} at ${wanted} or smaller`)
      entry.resolution = maps.find(({ map }) => map === 'diff')!.resolution
      for (const { map, resolution, jpg } of maps) {
        const name = basename(new URL(jpg.url).pathname)
        copies.push([name, await this.download(id, resolution, jpg, name)])
        entry.files[map] = urlOf(name)
      }
    }
    else {
      const found = pick(tree.gltf)
      const gltf = found?.[1].gltf
      if (!gltf)
        throw new HttpError(502, `Poly Haven has no glTF of ${id} at ${wanted} or smaller`)
      entry.resolution = found![0]
      const name = `${id}_${entry.resolution}.gltf`
      copies.push([name, await this.download(id, entry.resolution, gltf, name)])
      // The .bin and textures, at the paths the .gltf refers to them by
      for (const [path, file] of Object.entries(gltf.include ?? {}))
        copies.push([path, await this.download(id, entry.resolution, file, path)])
      entry.files.gltf = urlOf(name)
    }

    // Replace what an earlier import of it put there: this directory is the plugin's own
    const dir = resolveInside(this.ctx.publicDir, publicPath(id))!
    rmSync(dir, { recursive: true, force: true })
    for (const [path, cached] of copies) {
      const target = resolveInside(dir, path)
      if (!target)
        throw new HttpError(502, `Poly Haven listed a file outside the asset's directory: ${path}`)
      mkdirSync(dirname(target), { recursive: true })
      copyFileSync(cached, target)
    }

    let graphCreated = false
    if (kind === 'textures') {
      entry.graph = graphName(id)
      const file = join(this.ctx.projectRoot, 'graphs', `${entry.graph}.graph.json`)
      if (!existsSync(file)) {
        writeAtomic(file, `${JSON.stringify(textureGraph(id, Object.keys(entry.files) as TextureMap[]), null, 2)}\n`)
        graphCreated = true
      }
    }

    this.ctx.updateOptions((options) => {
      options.imported = [
        ...importedAssets(options).filter(existing => existing.id !== id),
        entry,
      ]
    })
    this.ctx.logger.info(`Poly Haven: imported ${kind.slice(0, -1)} ${id} at ${entry.resolution} into ${publicPath(id)}/`)
    return { ...entry, graphCreated }
  }
}

function sendJson(res: ServerResponse, status: number, body: unknown) {
  res.statusCode = status
  res.setHeader('Content-Type', 'application/json')
  res.end(JSON.stringify(body))
}

/** The routes the editor panel calls, under `devPluginBase('@mavonengine/polyhaven')` */
export function polyHavenMiddleware(ctx: PolyHavenContext, polyHaven = new PolyHaven(ctx)): DevMiddleware {
  return async (req: IncomingMessage, res: ServerResponse, next) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const [, route, arg] = url.pathname.split('/')
    try {
      if (req.method === 'GET' && route === 'assets' && ASSET_KINDS.includes(arg as AssetKind))
        return sendJson(res, 200, { assets: await polyHaven.list(arg as AssetKind) })

      if (req.method === 'GET' && route === 'thumbs' && arg?.endsWith('.png')) {
        const file = await polyHaven.thumbnail(arg.slice(0, -'.png'.length))
        res.setHeader('Content-Type', 'image/png')
        res.setHeader('Cache-Control', 'max-age=604800')
        res.end(readFileSync(file))
        return
      }

      if (req.method === 'GET' && route === 'imported' && !arg) {
        return sendJson(res, 200, {
          imported: importedAssets(ctx.options),
        })
      }

      if (req.method === 'POST' && route === 'import' && !arg) {
        let body: { id?: unknown, kind?: unknown, resolution?: unknown }
        try {
          body = JSON.parse(await readBody(req, 4096))
        }
        catch {
          throw new HttpError(400, 'Send { id, kind, resolution } as JSON')
        }
        const imported = await polyHaven.import(String(body.id), String(body.kind) as AssetKind, String(body.resolution ?? '1k') as Resolution)
        return sendJson(res, 200, { imported })
      }
    }
    catch (err) {
      const status = err instanceof HttpError
        ? err.status
        : 500
      if (status >= 500)
        ctx.logger.warn(`Poly Haven: ${req.method} ${req.url} failed: ${(err as Error).message}`)
      return sendJson(res, status, { error: (err as Error).message })
    }
    next()
  }
}

export default defineDevPlugin({
  name: 'Poly Haven',
  middleware: ctx => polyHavenMiddleware(ctx),
})
