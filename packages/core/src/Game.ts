import type { World } from '@dimforge/rapier3d-compat'
import type IEditor from './Types/IEditor'
import type { Asset } from './Types/Asset'
import * as THREE from 'three'
import BaseGame from './BaseGame'
import Camera from './Camera'
import InputManager from './InputManager'
import ParticleSystem from './Particles/System/ParticleSystem'
import Renderer from './Renderer'
import { RapierDebugRenderer } from './Renderer/PhysicsRenderer'
import Debug from './Utils/Debug'
import LoadingScreen from './Utils/LoadingScreen'
import Logger from './Utils/Logger'
import Resources from './Utils/Resources'
import Sizes from './Utils/Sizes'
import ClientGameWorld from './World/World'
import './style.css'

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

    this.resources = new Resources(sources)

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

    this.physicsDebugRender?.update()
    this.camera.update(delta)
  }
}
