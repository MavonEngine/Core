import type { World } from '@dimforge/rapier3d-compat'
import type { ClientPlugin, ClientPluginContext, LoadedPlugin } from './Plugins/types'
import type { Asset } from './Types/Asset'
import type IEditor from './Types/IEditor'
import * as THREE from 'three'
import BaseGame from './BaseGame'
import Camera from './Camera'
import InputManager from './InputManager'
import ParticleSystem from './Particles/System/ParticleSystem'
import PluginHost from './Plugins/PluginHost'
import { pluginAssetBase } from './Plugins/types'
import { registerPrefab } from './Prefab/PrefabRegistry'
import Renderer from './Renderer'
import { RapierDebugRenderer } from './Renderer/PhysicsRenderer'
import Debug from './Utils/Debug'
import LoadingScreen from './Utils/LoadingScreen'
import Logger from './Utils/Logger'
import Resources from './Utils/Resources'
import Sizes from './Utils/Sizes'
import ClientGameWorld from './World/World'
import './style.css'

const LEADING_SLASHES_RE = /^\/+/

export default class Game extends BaseGame {
  canvas = document.createElement('canvas') as HTMLCanvasElement
  uiRoot = document.createElement('div') as HTMLDivElement

  readonly sizes: Sizes

  camera: Camera
  renderer: Renderer
  resources: Resources
  debug: Debug
  input: InputManager
  audio: THREE.Audio
  physicsDebugRender?: RapierDebugRenderer
  particleSystem: ParticleSystem

  loadingScreen: LoadingScreen

  editor?: IEditor

  /**
   * Optional hook invoked in dev mode after the game is initialized.
   * Set this before constructing Game to register the editor or other dev tools.
   * e.g. `Game.devModeHook = () => Editor.registerListener()`
   */
  static devModeHook?: () => void

  private static pluginsToLoad: LoadedPlugin<ClientPlugin>[] = []

  /**
   * Engine plugins to run, set before constructing Game. Usually the plugins enabled in mavonengine.json:
   * `import plugins from 'virtual:mavonengine/plugins'; Game.usePlugins(plugins)`
   */
  static usePlugins(plugins: (ClientPlugin | LoadedPlugin<ClientPlugin>)[]) {
    Game.pluginsToLoad = plugins.map((plugin, index) => 'plugin' in plugin && 'package' in plugin
      ? plugin as LoadedPlugin<ClientPlugin>
      : { package: (plugin as ClientPlugin).name ?? `plugin-${index}`, options: {}, plugin: plugin as ClientPlugin })
  }

  plugins: PluginHost<ClientPlugin, ClientPluginContext>

  declare world: ClientGameWorld

  /**
   * Removing the prevention of right clicking
   * for in the editor
   */
  contextMenuAbort = new AbortController()

  /**
   * @param sources The source files to load when launching the game
   */
  constructor(
    sources: Asset[],
    physicsWorld?: World,
    renderParameters: THREE.WebGLRendererParameters = {},
  ) {
    super(
      // eslint-disable-next-line node/prefer-global/process
      new Logger(process.env.NODE_ENV === 'production' ? 'error' : 'debug'),
      physicsWorld,
    )

    this.initDocument()

    this.debug = new Debug()

    window.Game = this

    this.sizes = new Sizes()

    this.sizes.on('resize', () => {
      this.resize()
    })

    this.plugins = this.createPluginHost()
    this.resources = new Resources([...sources, ...this.pluginAssets()])

    this.loadingScreen = new LoadingScreen(this.resources)

    this.audio = new THREE.Audio(new THREE.AudioListener())
    this.camera = new Camera(this.audio.listener)

    this.renderer = new Renderer({
      canvas: this.canvas,
      ...renderParameters,
    })

    this.input = new InputManager()

    this.particleSystem = new ParticleSystem()

    this.physicsWorld = physicsWorld
    if (this.physicsWorld) {
      this.physicsDebugRender = new RapierDebugRenderer(this.scene, this.physicsWorld)
    }

    this.world = new ClientGameWorld()

    this.plugins.run('setup')
    this.on('editorBoot', () => this.plugins.run('editor'))

    if (this.isDevMode()) {
      Game.devModeHook?.()
    }

    const render = () => {
      const delta = this.clock.getDelta()

      this.particleSystem.update(delta)
      this.renderer.update(delta)

      window.requestAnimationFrame(() => render())
    }

    render()
  }

  private createPluginHost() {
    // eslint-disable-next-line ts/no-this-alias
    const game = this
    return new PluginHost<ClientPlugin, ClientPluginContext>(Game.pluginsToLoad, loaded => ({
      package: loaded.package,
      options: loaded.options,
      game,
      logger: game.logger,
      get editor() {
        return game.editor
      },
      assetUrl: path => `${pluginAssetBase(loaded.package)}${path.replace(LEADING_SLASHES_RE, '')}`,
      registerPrefab: prefab => registerPrefab({ ...prefab, plugin: loaded.package }),
    }), this.logger, 'client')
  }

  /**
   * The plugins' resources. In a release, those whose files were left out (prefabs the project doesn't use) are skipped.
   */
  private pluginAssets(): Asset[] {
    const shipped = new Map(this.plugins.plugins.map(p => [p.package, p.shippedAssets && new Set(p.shippedAssets)]))

    return this.plugins.collect('assets').flatMap(({ plugin, result: assets }) => {
      const pkg = plugin.package
      return assets.filter((asset) => {
        const files = shipped.get(pkg)
        if (!files)
          return true

        const base = pluginAssetBase(pkg)
        const paths = Array.isArray(asset.path) ? asset.path : [asset.path]
        const missing = paths.some(path => path.startsWith(base) && !files.has(path.slice(base.length)))
        if (missing)
          this.logger?.debug(`Plugin ${pkg}: skipping asset ${asset.name}, it is not part of this release`)
        return !missing
      })
    })
  }

  private initDocument() {
    document.body.appendChild(this.canvas)
    this.uiRoot.setAttribute('id', 'ui')
    this.uiRoot.style.opacity = '0'
    this.canvas.parentNode!.insertBefore(this.uiRoot, this.canvas)

    // Prevent drag event in firefox triggering a screengrab / image drag from the current canvas state
    this.canvas.setAttribute('draggable', 'false')
    this.canvas.addEventListener('mousedown', (e) => {
      e.preventDefault()
    })
    document.getElementsByTagName('body')[0].setAttribute('onContextMenu', 'return false;')

    /**
     * Prevent right click context menu
     */
    document.addEventListener('contextmenu', (e) => {
      e.preventDefault()
    }, {
      signal: this.contextMenuAbort.signal,
    })

    queueMicrotask(() => this.trigger('documentReady'))
  }

  static instance(): Game {
    return super.instance() as Game
  }

  private resize() {
    this.camera.resize()
    this.renderer.resize()
  }

  update(delta: number) {
    if (this.editor) {
      this.editor.update(delta)
    }

    this.loadingScreen.update(delta)

    super.update(delta)
    this.plugins.run('update', delta)

    this.physicsDebugRender?.update()
    this.camera.update(delta)
  }
}
