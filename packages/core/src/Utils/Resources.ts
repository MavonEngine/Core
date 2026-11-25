import type { CubeTexture, Texture } from 'three'
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js'
import type { Font, SVGResult } from 'three/examples/jsm/Addons.js'
import type { Asset } from '../Types/Asset'
import { AudioLoader, CubeTextureLoader, TextureLoader } from 'three'
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { FontLoader, SVGLoader } from 'three/examples/jsm/Addons.js'
import EventEmitter from './EventEmitter'

type AssetType = GLTF | Texture | CubeTexture | AudioBuffer | SVGResult | Font

export default class Resources extends EventEmitter {
  sources: Asset[]
  loaded: number
  toLoad: number
  items: { [key: string]: AssetType }

  loaders!: {
    gltfLoader: GLTFLoader
    textureLoader: TextureLoader
    cubeTextureLoader: CubeTextureLoader
    audioLoader: AudioLoader
    svgLoader: SVGLoader
    fontLoader: FontLoader
  }

  constructor(sources: Asset[]) {
    super()

    this.sources = sources

    this.items = {}
    this.toLoad = this.sources.length
    this.loaded = 0

    this.loaders = {
      gltfLoader: new GLTFLoader(),
      textureLoader: new TextureLoader(),
      cubeTextureLoader: new CubeTextureLoader(),
      audioLoader: new AudioLoader(),
      svgLoader: new SVGLoader(),
      fontLoader: new FontLoader(),
    }
    this.loaders.gltfLoader.dracoLoader = new DRACOLoader()
    this.loaders.gltfLoader.dracoLoader.setDecoderPath('/draco/')

    this.startLoading()
  }

  startLoading() {
    this.sources.forEach((source) => {
      const { type, path } = source

      const loadHandler = (loader: GLTFLoader | TextureLoader | AudioLoader | SVGLoader | FontLoader, path: string | string[]) => {
        if (Array.isArray(path)) {
          path.forEach(p => loader.load(p, data => this.sourceLoaded(source, data)))
        }
        else {
          loader.load(path, data => this.sourceLoaded(source, data))
        }
      }

      switch (type) {
        case 'gltfModel':
          loadHandler(this.loaders.gltfLoader, path)
          break
        case 'texture':
          loadHandler(this.loaders.textureLoader, path)
          break
        case 'sound':
          loadHandler(this.loaders.audioLoader, path)
          break
        case 'svg':
          loadHandler(this.loaders.svgLoader, path)
          break
        case 'font':
          loadHandler(this.loaders.fontLoader, path)
          break
        case 'cubeTexture':
          this.loaders.cubeTextureLoader.load([...path], data => this.sourceLoaded(source, data))
          break
      }
    })
  }

  /**
   * Load more assets while the game runs, e.g. ones a plugin imported while the editor is open. Resolves once all of
   * them are in `items`, and then triggers `assetsAdded` with their names; rejects when one fails to load, keeping the
   * ones that did. An asset with the name of one already loaded replaces it. Doesn't trigger `progress` or `loaded`,
   * which are for the assets the game starts with.
   */
  async add(sources: Asset[]): Promise<void> {
    const results = await Promise.allSettled(sources.map(async (source) => {
      const item = await this.loadSource(source)
      this.items[source.name] = item
      this.sources = [
        ...this.sources.filter(existing => existing.name !== source.name),
        source,
      ]
      return source.name
    }))

    const names = results.flatMap(result => result.status === 'fulfilled'
      ? [result.value]
      : [])
    if (names.length)
      this.trigger('assetsAdded', { names })

    const failed = results.flatMap((result, i) => result.status === 'rejected'
      ? [`${sources[i].name}: ${(result.reason as Error)?.message ?? result.reason}`]
      : [])
    if (failed.length)
      throw new Error(`Could not load ${failed.join(', ')}`)
  }

  private loadSource(source: Asset): Promise<AssetType> {
    const { type } = source
    const path = type !== 'cubeTexture' && Array.isArray(source.path)
      ? source.path[0]
      : source.path
    const loader = {
      gltfModel: this.loaders.gltfLoader,
      texture: this.loaders.textureLoader,
      sound: this.loaders.audioLoader,
      svg: this.loaders.svgLoader,
      font: this.loaders.fontLoader,
      cubeTexture: this.loaders.cubeTextureLoader,
    }[type] as { loadAsync(path: unknown): Promise<AssetType> } | undefined

    if (!loader)
      return Promise.reject(new Error(`unknown asset type ${type}`))
    return loader.loadAsync(type === 'cubeTexture'
      ? [...path]
      : path)
  }

  private sourceLoaded(source: Asset, file: AssetType) {
    this.items[source.name] = file
    this.loaded++

    this.trigger('progress', {
      loaded: this.loaded,
      total: this.sources.length,
    })

    if (this.loaded === this.toLoad) {
      this.trigger('loaded')
    }
  }
}
