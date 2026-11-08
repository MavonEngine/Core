import type GameScene from '@mavonengine/core/Scene/GameScene'
import type { SceneData } from '@mavonengine/core/Scene/types'
import type { EditorPanel } from '@mavonengine/core/Types/IEditor'
import type IEditor from '@mavonengine/core/Types/IEditor'
import type GameObjectInterface from '@mavonengine/core/World/GameObjectInterface'
import type { Root } from 'react-dom/client'
import type { Material, MeshBasicMaterial, Object3DEventMap } from 'three'
import type { TransformControlsMode } from 'three/examples/jsm/controls/TransformControls.js'
import type { EditorPanelDefinition } from './Editor/panels'
import EditorHelper from '@mavonengine/core/Editor/EditorHelper'
import Game from '@mavonengine/core/Game'
import { SCENE_SAVE_PATH } from '@mavonengine/core/Plugins/types'
import EventEmitter from '@mavonengine/core/Utils/EventEmitter'
import { Matrix4, Mesh, Object3D, Vector2, Vector3 } from 'three'
import { FlyControls } from 'three/examples/jsm/controls/FlyControls.js'
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js'
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js'
import { applyShadeMode } from './Editor/applyShadeMode'
import { DEFAULT_SCENE_NAME, demoScene } from './Editor/demoScene'
import { registerEditorPanel, unregisterEditorPanel } from './Editor/panels'

export type { EditorPanelDefinition, EditorPanelLocation } from './Editor/panels'
export { registerEditorPanel, unregisterEditorPanel } from './Editor/panels'

export type ShadeMode = 'solid' | 'flat' | 'wireframe'

export default class Editor extends EventEmitter implements IEditor, GameObjectInterface {
  flyControls!: FlyControls
  reactRoot!: Root
  activeItem?: Object3D<Object3DEventMap> | null
  outlinePass!: OutlinePass
  activeToolMode: TransformControlsMode = 'translate'
  transformControls?: TransformControls
  private shadeMode: ShadeMode = 'solid'
  private originalMaterials = new Map<string, Material | Material[]>()
  private shadeOverrideMaterials = new Map<string, MeshBasicMaterial>()
  private flatColors = new Map<string, number>()
  private helpers: EditorHelper[] = []
  private lightHelpers: Object3D[] = []
  private _showHelpers = true
  private abort = new AbortController()
  private saving?: Promise<boolean>

  availableAssetCategories!: string[]
  activeAssetCategory: 'Object' | '_texture' | 'CubeTexture' | 'AudioBuffer' | 'Font' = 'Object'

  /**
   * Dock a custom panel in the editor, before or after it booted. Same as `editor.addPanel()`
   */
  static registerPanel(panel: EditorPanelDefinition | EditorPanel): () => void {
    return registerEditorPanel(panel)
  }

  /**
   * The editor should only be instantiated when button is pressed
   */
  static registerListener() {
    Game.instance().input.on('keydown', (ev: KeyboardEvent) => {
      if (ev.code === 'Insert' || ev.code === 'Period') {
        Game.instance().editor = new Editor()
      }
    })
  }

  constructor() {
    super()

    // Assign early so WithEditorHelper mixins can register helpers during initEditorScene
    Game.instance().editor = this

    Game.instance().logger?.info('Booting Editor')

    Game.instance().trigger('editorBoot', this)
    Game.instance().trigger('uiDestroy', this)

    const scene = Game.instance().activeScene
    if (scene) {
      // Keep the running game: the scene, and what the server sent. Rebuilt so its objects get their editor helpers
      scene.rebuild()
    }
    else {
      this.clearGame()
    }

    this.initEditorScene()

    if (!scene)
      void this.openDefaultScene()

    // Force removal of any previously mounted html
    Game.instance().contextMenuAbort.abort()
    Game.instance().uiRoot.innerHTML = ''
    Game.instance().uiRoot.style.opacity = '1'
    document.title = 'MavonEngine | Editor'
    document.getElementsByTagName('body')[0].removeAttribute('onContextMenu')
    Promise.all([
      import('./Editor/mount'),
      import('./Editor/UI/global.css'),
    ]).then(([{ mountEditorUI }]) => {
      this.reactRoot = mountEditorUI(Game.instance().uiRoot)
    })
  }

  private initEditorScene() {
    Game.instance().camera.instance.position.set(20, 10, 20)
    Game.instance().camera.instance.rotation.set(0, 0, 0)
    Game.instance().camera.instance.rotateY((Math.PI / 360) * 90)
    Game.instance().camera.instance.rotateX((Math.PI / 360) * -45)

    this.outlinePass = new OutlinePass(
      new Vector2(Game.instance().sizes.width, Game.instance().sizes.height),
      Game.instance().scene,
      Game.instance().camera.instance,
    )

    Game.instance().renderer.composer.addPass(this.outlinePass)

    this.initFlyControls()

    this.watchScene(Game.instance().activeScene)
    Game.instance().on('sceneLoaded', (scene: GameScene) => {
      this.deselect()
      this.watchScene(scene)
      this.trigger('sceneChanged')
    })

    window.addEventListener('keydown', (ev) => {
      if ((ev.ctrlKey || ev.metaKey) && ev.code === 'KeyS') {
        ev.preventDefault()
        void this.saveScene()
      }
    }, { signal: this.abort.signal })

    this.trigger('sceneChanged')

    Game.instance().input.on('mousedown', (ev) => {
      if (ev.target !== Game.instance().canvas)
        return

      this.handleCanvasClick(ev)
    })

    Game.instance().input.on('keydown', (ev: KeyboardEvent) => {
      if (ev.code === 'Escape' && this.activeItem) {
        this.deselect()
      }
    })

    this.handleItemDelete()

    this.on('setTransformMode', (mode: TransformControlsMode) => {
      this.activeToolMode = mode
      this.transformControls?.setMode(mode)
      Game.instance().logger?.info(`Setting editor tool mode: ${mode}`)
    })

    this.on('setShadeMode', (mode: ShadeMode) => {
      this.applyShadeMode(mode)
    })

    this.on('assetDropped', () => {
      if (this.shadeMode !== 'solid') {
        this.applyShadeMode(this.shadeMode)
      }
    })

    this.initAssetsFilter()
  }

  private initAssetsFilter() {
    this.availableAssetCategories = [
      ...new Set(Object.entries(Game.instance().resources.items).map(([_, item]) => item.constructor.name)),
    ]
  }

  setActiveAssetCategory(value: typeof this.activeAssetCategory): void {
    this.activeAssetCategory = value
  }

  private applyShadeMode(mode: ShadeMode) {
    this.shadeMode = mode
    applyShadeMode(Game.instance().scene, mode, this.originalMaterials, this.shadeOverrideMaterials, this.flatColors)
  }

  private initFlyControls() {
    this.flyControls = new FlyControls(Game.instance().camera.instance, Game.instance().canvas)
    this.flyControls.autoForward = false
    this.flyControls.dragToLook = true
    this.flyControls.movementSpeed = 10
    this.flyControls.rollSpeed = 0.5
  }

  private handleItemDelete() {
    Game.instance().input.on('keydown', (ev) => {
      if (ev.code === 'Delete' && this.activeItem) {
        let root: Object3D = this.activeItem
        while (root.parent && root.parent !== Game.instance().scene) {
          root = root.parent
        }

        root.traverse((child) => {
          if (child instanceof Mesh) {
            child.geometry?.dispose()
            if (Array.isArray(child.material)) {
              child.material.forEach(m => m.dispose())
            }
            else {
              child.material?.dispose()
            }
          }
        })

        this.deselect()

        const helper = EditorHelper.from(root)
        const scene = Game.instance().activeScene
        const entry = scene?.entryOfObject3D(root)
          ?? (helper?.owner && scene?.getEntries().find(e => e.object === helper.owner))
        if (scene && entry) {
          scene.remove(entry.data.id)
        }
        else if (helper?.owner) {
          helper.owner.destroy()
        }
        else {
          if (helper) {
            helper.dispose()
            this.helpers = this.helpers.filter(h => h !== helper)
          }
          Game.instance().scene.remove(root)
        }
        this.trigger('sceneChanged')
      }
    })
  }

  deselect(): void {
    this.transformControls?.detach()
    this.outlinePass.selectedObjects = []
    this.activeItem = null
    this.trigger('objectDeselected')
  }

  selectObject(object: Object3D): void {
    this.activeItem = object
    this.trigger('objectSelected', this.activeItem)
    this.outlinePass.selectedObjects = [this.activeItem]
    this.handleHelperTool()
  }

  private handleCanvasClick(ev: MouseEvent) {
    if (ev.button === 0) {
      if (this.transformControls && (this.transformControls.dragging || this.transformControls.axis !== null)) {
        return
      }

      const object = Game.instance().input.getPointerWorldPosition(undefined, null, true)

      if (object instanceof Object3D) {
        this.selectObject(object)
      }
      else {
        this.deselect()
      }
    }
  }

  private handleHelperTool() {
    if (!this.transformControls) {
      this.transformControls = new TransformControls(
        Game.instance().camera.instance,
        Game.instance().canvas,
      )
      this.transformControls.addEventListener('dragging-changed', (event) => {
        this.flyControls.enabled = !event.value
        if (!event.value) {
          /**
           * Bit of a hack but it was needed because the fly controls camera would move with the mounter after
           * releasing the transfom controls. Maybe a better way here instead of initializing whole
           * new flyControls again
           */
          this.initFlyControls()
        }
      })
      const tcHelper = this.transformControls.getHelper()
      tcHelper.userData.isEditorInternal = true
      Game.instance().scene.add(tcHelper)
    }

    this.transformControls.setMode(this.activeToolMode)
    this.transformControls.attach(this.activeItem!)
  }

  addPanel(panel: EditorPanelDefinition | EditorPanel): () => void {
    return registerEditorPanel(panel)
  }

  removePanel(id: string): void {
    unregisterEditorPanel(id)
  }

  /**
   * Save the active scene to `scenes/<name>.json` through the dev server.
   * Triggers `sceneSaved` ({ name, file }) or `sceneSaveFailed` ({ name, error }).
   */
  saveScene(fetchFn: typeof fetch = fetch): Promise<boolean> {
    const scene = Game.instance().activeScene
    if (!scene) {
      Game.instance().logger?.warn('No scene to save')
      return Promise.resolve(false)
    }

    // A second Ctrl+S while saving waits for the first
    if (this.saving)
      return this.saving

    const name = scene.source ?? DEFAULT_SCENE_NAME
    const data = scene.serialize()
    this.trigger('sceneSaving', { name })

    const fail = (error: string) => {
      Game.instance().logger?.error(`Could not save scene ${name}: ${error}`)
      this.trigger('sceneSaveFailed', { name, error })
      return false
    }

    this.saving = fetchFn(SCENE_SAVE_PATH, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, scene: data }),
    }).then(async (res) => {
      const body = await res.json().catch(() => ({})) as { error?: string, file?: string, scene?: SceneData }
      if (!res.ok)
        return fail(body.error ?? `${res.status} ${res.statusText}`)

      scene.source = name
      scene.markSaved(data)
      Game.instance().logger?.info(`Saved scene ${name} to ${body.file ?? name}`)
      this.trigger('sceneSaved', { name, file: body.file })
      return true
    }, (err: Error) => fail(err.message)).finally(() => {
      this.saving = undefined
    })

    return this.saving
  }

  /** Without a scene loaded by the game, open `scenes/main.json`, or a demo scene when there is none yet */
  private async openDefaultScene() {
    try {
      await Game.instance().openScene(DEFAULT_SCENE_NAME)
    }
    catch {
      Game.instance().logger?.info(`No scenes/${DEFAULT_SCENE_NAME}.json yet, opening a demo scene. Save it with Ctrl+S`)
      Game.instance().loadScene(demoScene(), DEFAULT_SCENE_NAME)
    }
  }

  private watchScene(scene?: GameScene) {
    scene?.on('changed', () => this.trigger('sceneChanged'))
  }

  /** The old way, for games that don't use scenes: start from an empty world */
  private clearGame() {
    Game.instance().world.destroy()
    Game.instance().world.entities.items.clear()
    Game.instance().scene.traverse((child) => {
      if (child instanceof Mesh) {
        child.geometry?.dispose()
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.dispose())
        }
        else {
          child.material?.dispose()
        }
      }
    })
    Game.instance().scene.clear()
  }

  addHelper(helper: EditorHelper): void {
    this.helpers.push(helper)
    if (!this._showHelpers) {
      helper.mesh.visible = false
      helper.label.domElement.style.display = 'none'
    }
  }

  removeHelper(helper: EditorHelper): void {
    this.helpers = this.helpers.filter(h => h !== helper)
  }

  addLightHelper(helper: Object3D): void {
    this.lightHelpers.push(helper)
    if (!this._showHelpers)
      helper.visible = false
  }

  removeLightHelper(helper: Object3D): void {
    this.lightHelpers = this.lightHelpers.filter(h => h !== helper)
  }

  setShowHelpers(visible: boolean): void {
    this._showHelpers = visible
    this.helpers.forEach((h) => {
      h.mesh.visible = visible
      h.label.domElement.style.display = visible ? '' : 'none'
    })
    this.lightHelpers.forEach(h => (h.visible = visible))
  }

  update(delta: number): void {
    this.updateCamera(delta)
    this.helpers.forEach(h => h.update(delta))
  }

  updateCamera(delta: number) {
    this.flyControls.update(delta)

    /**
     * Keep the camera flat on the horizon.
     */
    const camera = Game.instance().camera.instance
    const forward = new Vector3()
    camera.getWorldDirection(forward)
    camera.quaternion.setFromRotationMatrix(
      new Matrix4().lookAt(new Vector3(), forward, new Vector3(0, 1, 0)),
    )
  }

  destroy(): void {
    this.abort.abort()
    this.reactRoot.unmount()
    this.outlinePass.dispose()
    this.shadeOverrideMaterials.forEach(m => m.dispose())
    this.shadeOverrideMaterials.clear()
    this.originalMaterials.clear()
    this.flatColors.clear()
  }
}
