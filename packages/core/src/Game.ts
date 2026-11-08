import type { World } from '@dimforge/rapier3d-compat'
import type { ClientPlugin, ClientPluginContext, LoadedPlugin } from './Plugins/types'
import type GameScene from './Scene/GameScene'
import type { SceneData, SceneSettings, SceneSide } from './Scene/types'
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
import { registerBuiltinSceneObjects } from './Scene/builtinSceneObjects'
import { registerSceneObject, sceneObjectKey } from './Scene/SceneObjectRegistry'
import { SCENE_NAME_RE, SCENES_DIR } from './Scene/types'
import Debug from './Utils/Debug'
import LoadingScreen from './Utils/LoadingScreen'
import Logger from './Utils/Logger'
import Resources from './Utils/Resources'
import Sizes from './Utils/Sizes'
import ClientGameWorld from './World/World'
import './style.css'

const LEADING_SLASHES_RE = /^\/+/
const JSON_EXT_RE = /\.json$/

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

  override readonly sceneSide: SceneSide = 'client'

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

    registerBuiltinSceneObjects()
    this.on('sceneLoaded', (scene: GameScene) => {
      this.applySceneSettings(scene.settings)
      scene.on('settingsChanged', (settings: SceneSettings) => this.applySceneSettings(settings))
    })

    this.plugins.run('setup')
    this.on('editorBoot', () => this.plugins.run('editor'))

    if (this.isDevMode()) {
      Game.devModeHook?.()
    }

    // The tick and physics run on their own interval, so skipping frames here for `renderer.maxFps` doesn't affect them
    const render = (now: number) => {
      if (this.renderer.shouldRender(now)) {
        // Measured since the last rendered frame, so the skipped frames' time isn't lost
        const delta = this.clock.getDelta()

        this.particleSystem.update(delta)
        this.renderer.update(delta)
      }

      window.requestAnimationFrame(render)
    }

    render(performance.now())
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
      registerSceneObject: (definition) => {
        registerSceneObject({ ...definition, plugin: loaded.package })
        return sceneObjectKey({ ...definition, plugin: loaded.package })
      },
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

  /**
   * Fetch a scene and load it once the resources are loaded, since scene objects may use them.
   *
   * @param scene a scene name, loaded from `/scenes/<name>.json`, a URL, or the scene data itself
   */
  async openScene(scene: string | SceneData): Promise<GameScene> {
    if (typeof scene !== 'string') {
      await this.resourcesReady()
      return this.loadScene(scene)
    }

    const isName = SCENE_NAME_RE.test(scene)
    const url = isName ? `/${SCENES_DIR}/${scene}.json` : scene
    const response = await fetch(url, { cache: 'no-store' })
    if (!response.ok)
      throw new Error(`Could not load scene ${url}: ${response.status} ${response.statusText}`)

    const data: unknown = await response.json()
    await this.resourcesReady()

    const source = isName ? scene : url.split('/').pop()?.replace(JSON_EXT_RE, '')
    return this.loadScene(data, source && SCENE_NAME_RE.test(source) ? source : undefined)
  }

  /** Resolves once every resource has loaded */
  resourcesReady(): Promise<void> {
    if (this.resources.loaded >= this.resources.toLoad)
      return Promise.resolve()
    return new Promise(resolve => this.resources.on('loaded', () => resolve()))
  }

  private applySceneSettings(settings: SceneSettings) {
    if (settings.background)
      this.scene.background = new THREE.Color(settings.background)
    else if (this.scene.background instanceof THREE.Color)
      this.scene.background = null

    this.scene.fog = settings.fog ? new THREE.FogExp2(settings.fog.color, settings.fog.density) : null
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

    this.input.update()

    super.update(delta)
    this.plugins.run('update', delta)

    this.physicsDebugRender?.update()
    this.camera.update(delta)
  }
}
