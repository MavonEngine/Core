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
