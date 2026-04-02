import type { LightPrimitive } from '@mavonengine/core/Prefab/Lights/index'
import type { Primitive } from '@mavonengine/core/Prefab/Primitives/index'
import type IEditor from '@mavonengine/core/Types/IEditor'
import type GameObjectInterface from '@mavonengine/core/World/GameObjectInterface'
import type { Root } from 'react-dom/client'
import type { Material, MeshBasicMaterial, Object3DEventMap } from 'three'
import type { TransformControlsMode } from 'three/examples/jsm/Addons.js'
import EditorHelper from '@mavonengine/core/Editor/EditorHelper'
import Game from '@mavonengine/core/Game'
import { AmbientLightPrimitive, DirectionalLightShadowPrimitive } from '@mavonengine/core/Prefab/Lights/index'
import { BoxPrimitive, CapsulePrimitive, ConePrimitive, CylinderPrimitive, DodecahedronPrimitive, IcosahedronPrimitive, OctahedronPrimitive, PlanePrimitive, SpherePrimitive, TorusKnotPrimitive } from '@mavonengine/core/Prefab/Primitives/index'
import EventEmitter from '@mavonengine/core/Utils/EventEmitter'
import { Matrix4, Mesh, Object3D, Vector2, Vector3 } from 'three'
import { FlyControls, OutlinePass, TransformControls } from 'three/examples/jsm/Addons.js'
import { applyShadeMode } from './Editor/applyShadeMode'

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

  availableAssetCategories!: string[]
  activeAssetCategory: 'Object' | '_texture' | 'CubeTexture' | 'AudioBuffer' | 'Font' = 'Object'

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

    Game.instance().world.destroy()
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

    this.initEditorScene()

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

    const ambientLight = new AmbientLightPrimitive(new Vector3(0, 5, 0))
    const directionalLight = new DirectionalLightShadowPrimitive(new Vector3(10, 15, 5))
    directionalLight.instance.intensity = 5

    const groundPlane = new PlanePrimitive(new Vector3(0, 0, 0), 50, 50)
    groundPlane.setReceiveShadow(true)
    if (groundPlane.instance instanceof Mesh) {
      (groundPlane.instance.material as MeshBasicMaterial).color.set('#ffbe6f')
    }

    const r = 5
    const sceneShapes = [
      new BoxPrimitive(new Vector3(r, 0.5, 0)),
      new SpherePrimitive(new Vector3(r * 0.707, 1, r * 0.707)),
      new ConePrimitive(new Vector3(0, 0.5, r)),
      new CylinderPrimitive(new Vector3(-r * 0.707, 0.5, r * 0.707)),
      new OctahedronPrimitive(new Vector3(-r, 1, 0)),
      new DodecahedronPrimitive(new Vector3(-r * 0.707, 1, -r * 0.707)),
      new CapsulePrimitive(new Vector3(0, 1, -r)),
      new IcosahedronPrimitive(new Vector3(r * 0.707, 1, -r * 0.707)),
      new TorusKnotPrimitive(new Vector3(0, 3.5, 0)),
    ]

    sceneShapes.forEach(s => s.setCastShadow(true))

    const worldEntries: Record<string, Primitive | LightPrimitive> = {};
    [ambientLight, directionalLight, groundPlane, ...sceneShapes].forEach(o => (worldEntries[o.id] = o))
    Game.instance().world.add(worldEntries)

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
        if (helper?.owner) {
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
    this.reactRoot.unmount()
    this.outlinePass.dispose()
    this.shadeOverrideMaterials.forEach(m => m.dispose())
    this.shadeOverrideMaterials.clear()
    this.originalMaterials.clear()
    this.flatColors.clear()
  }
}
