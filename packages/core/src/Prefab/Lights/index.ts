import type { Light } from 'three'
import {
  AmbientLight,
  DirectionalLight,
  DirectionalLightHelper,
  GridHelper,
  HemisphereLight,
  HemisphereLightHelper,
  LightProbe,
  Object3D,
  Plane,
  PlaneHelper,
  PointLight,
  PointLightHelper,
  PolarGridHelper,
  RectAreaLight,
  SkeletonHelper,
  SpotLight,
  SpotLightHelper,
  Vector3,
} from 'three'
import { WithEditorHelper } from '../../Editor/WithEditorHelper'
import Game from '../../Game'
import GameObject from '../../World/GameObject'

type UpdatableLightHelper = Object3D & { update(): void }

export abstract class LightPrimitive extends WithEditorHelper(GameObject) {
  public instance: Light
  protected lightHelper?: UpdatableLightHelper

  constructor(position: Vector3, light: Light, label: string) {
    super(undefined, position)
    this.instance = light
    this.instance.position.copy(position)
    Game.instance().scene.add(this.instance)
    this.registerEditorHelper(position, label, {
      onMove: (delta: Vector3) => this.instance.position.add(delta),
      properties: [
        { type: 'color', label: 'color', getValue: () => `#${this.instance.color.getHexString()}`, setValue: v => this.instance.color.set(v) },
        { type: 'slider', label: 'intensity', min: 0, max: 10, step: 0.01, getValue: () => this.instance.intensity, setValue: v => (this.instance.intensity = v) },
        { type: 'checkbox', label: 'castShadow', getValue: () => this.instance.castShadow, setValue: v => (this.instance.castShadow = v) },
      ],
    })
    this.tagWithHelper(this.instance)
  }

  protected addLightHelper(helper: UpdatableLightHelper): void {
    const editor = Game.instance().editor
    if (!editor)
      return
    this.lightHelper = helper
    Game.instance().scene.add(helper)
    editor.addLightHelper(helper)
  }

  update(_delta: number): void {
    this.lightHelper?.update()
  }

  destroy(): void {
    if (this.lightHelper) {
      Game.instance().editor?.removeLightHelper(this.lightHelper)
      Game.instance().scene.remove(this.lightHelper)
      this.lightHelper = undefined
    }
    Game.instance().scene.remove(this.instance)
    super.destroy()
  }
}

export class AmbientLightPrimitive extends LightPrimitive {
  constructor(position: Vector3) {
    super(position, new AmbientLight(0xFFFFFF, 1), 'AmbientLight')
  }
}

export class DirectionalLightPrimitive extends LightPrimitive {
  constructor(position: Vector3) {
    super(position, new DirectionalLight(0xFFFFFF, 1), 'DirectionalLight')
    this.addLightHelper(new DirectionalLightHelper(this.instance as DirectionalLight))
  }
}

export class DirectionalLightShadowPrimitive extends LightPrimitive {
  constructor(position: Vector3) {
    const light = new DirectionalLight(0xFFFFFF, 1)
    light.castShadow = true
    super(position, light, 'DirectionalLightShadow')
    this.addLightHelper(new DirectionalLightHelper(this.instance as DirectionalLight))
  }
}

export class HemisphereLightPrimitive extends LightPrimitive {
  constructor(position: Vector3) {
    super(position, new HemisphereLight(0xFFFFFF, 0x444444, 1), 'HemisphereLight')
    this.addLightHelper(new HemisphereLightHelper(this.instance as HemisphereLight, 1))
  }
}

export class LightProbePrimitive extends LightPrimitive {
  constructor(position: Vector3) {
    super(position, new LightProbe(), 'LightProbe')
  }
}

export class PointLightPrimitive extends LightPrimitive {
  constructor(position: Vector3) {
    super(position, new PointLight(0xFFFFFF, 1), 'PointLight')
    this.addLightHelper(new PointLightHelper(this.instance as PointLight))
  }
}

export class PointLightShadowPrimitive extends LightPrimitive {
  constructor(position: Vector3) {
    const light = new PointLight(0xFFFFFF, 1)
    light.castShadow = true
    super(position, light, 'PointLightShadow')
    this.addLightHelper(new PointLightHelper(this.instance as PointLight))
  }
}

export class RectAreaLightPrimitive extends LightPrimitive {
  constructor(position: Vector3) {
    super(position, new RectAreaLight(0xFFFFFF, 1, 4, 4), 'RectAreaLight')
  }
}

export class SpotLightPrimitive extends LightPrimitive {
  constructor(position: Vector3) {
    super(position, new SpotLight(0xFFFFFF, 1), 'SpotLight')
    this.addLightHelper(new SpotLightHelper(this.instance as SpotLight))
  }
}

export class SpotLightShadowPrimitive extends LightPrimitive {
  constructor(position: Vector3) {
    const light = new SpotLight(0xFFFFFF, 1)
    light.castShadow = true
    super(position, light, 'SpotLightShadow')
    this.addLightHelper(new SpotLightHelper(this.instance as SpotLight))
  }
}

// ─── Standalone scene-level helpers (editor-only) ──────────────────────────

abstract class SceneHelperPrimitive extends WithEditorHelper(GameObject) {
  protected helper: Object3D

  constructor(position: Vector3, helper: Object3D, label: string) {
    super(undefined, position)
    this.helper = helper
    this.helper.position.copy(position)
    Game.instance().scene.add(this.helper)
    this.registerEditorHelper(position, label, {
      onMove: (delta: Vector3) => this.helper.position.add(delta),
    })
    this.tagWithHelper(this.helper)
    Game.instance().editor?.addLightHelper(this.helper)
  }

  update(_delta: number): void {}

  destroy(): void {
    Game.instance().editor?.removeLightHelper(this.helper)
    Game.instance().scene.remove(this.helper)
    super.destroy()
  }
}

export class GridHelperPrimitive extends SceneHelperPrimitive {
  constructor(position: Vector3) {
    super(position, new GridHelper(10, 10), 'GridHelper')
  }
}

export class PolarGridHelperPrimitive extends SceneHelperPrimitive {
  constructor(position: Vector3) {
    super(position, new PolarGridHelper(10, 16), 'PolarGridHelper')
  }
}

export class PlaneHelperPrimitive extends SceneHelperPrimitive {
  constructor(position: Vector3) {
    super(position, new PlaneHelper(new Plane(new Vector3(0, 1, 0), -position.y), 10), 'PlaneHelper')
  }
}

export class SkeletonHelperPrimitive extends SceneHelperPrimitive {
  constructor(position: Vector3) {
    const root = new Object3D()
    root.position.copy(position)
    super(position, new SkeletonHelper(root), 'SkeletonHelper')
  }
}

export const LIGHT_REGISTRY: Record<string, new (position: Vector3) => LightPrimitive> = {
  AmbientLight: AmbientLightPrimitive,
  DirectionalLight: DirectionalLightPrimitive,
  DirectionalLightShadow: DirectionalLightShadowPrimitive,
  HemisphereLight: HemisphereLightPrimitive,
  LightProbe: LightProbePrimitive,
  PointLight: PointLightPrimitive,
  PointLightShadow: PointLightShadowPrimitive,
  RectAreaLight: RectAreaLightPrimitive,
  SpotLight: SpotLightPrimitive,
  SpotLightShadow: SpotLightShadowPrimitive,
}

export const SCENE_HELPER_REGISTRY: Record<string, new (position: Vector3) => SceneHelperPrimitive> = {
  GridHelper: GridHelperPrimitive,
  PolarGridHelper: PolarGridHelperPrimitive,
  PlaneHelper: PlaneHelperPrimitive,
  SkeletonHelper: SkeletonHelperPrimitive,
}
