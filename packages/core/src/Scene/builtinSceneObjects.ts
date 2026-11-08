import type { Group, Light, LightShadow } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { LightPrimitive } from '../Prefab/Lights/index'
import type { Primitive } from '../Prefab/Primitives/index'
import { Mesh, MeshStandardMaterial, OrthographicCamera, Vector3 } from 'three'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import Game from '../Game'
import { LIGHT_REGISTRY } from '../Prefab/Lights/index'
import { getPrefab, spawnPrefab } from '../Prefab/PrefabRegistry'
import { PlanePrimitive, PRIMITIVE_REGISTRY } from '../Prefab/Primitives/index'
import GameObject from '../World/GameObject'
import { registerSceneObject, registerSceneObjectResolver } from './SceneObjectRegistry'

/**
 * The client side of the scene object types that come with the engine. None of them exist on the server,
 * they are visuals only; a project registers `server` factories for what the server needs.
 *
 * - `Primitive:<Box|Sphere|…>` props: color, roughness, metalness, wireframe, castShadow, receiveShadow (+ width, height for Plane)
 * - `Light:<AmbientLight|DirectionalLight|…>` props: color, intensity, castShadow, shadowMapSize (+ shadowArea, shadowFar for directional lights)
 * - `Model` props: resource (name of a loaded gltfModel), castShadow, receiveShadow
 * - `prefab:<key>` any prefab of the prefab registry, by its key
 */

export function primitiveType(name: string) {
  return `Primitive:${name}`
}

export function lightType(name: string) {
  return `Light:${name}`
}

export const MODEL_TYPE = 'Model'

export function prefabType(key: string) {
  return `prefab:${key}`
}

type Props = Record<string, unknown>

const str = (v: unknown) => (typeof v === 'string' ? v : undefined)
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined)
const bool = (v: unknown) => (typeof v === 'boolean' ? v : undefined)

function primitiveProps(primitive: Primitive): Props {
  const props: Props = {}
  const mesh = primitive.instance
  if (mesh instanceof Mesh) {
    props.castShadow = mesh.castShadow
    props.receiveShadow = mesh.receiveShadow
    if (mesh.material instanceof MeshStandardMaterial) {
      props.color = `#${mesh.material.color.getHexString()}`
      props.roughness = mesh.material.roughness
      props.metalness = mesh.material.metalness
      if (mesh.material.wireframe)
        props.wireframe = true
    }
  }
  if (primitive instanceof PlanePrimitive) {
    props.width = primitive.width
    props.height = primitive.height
  }
  return props
}

function applyPrimitiveProps(primitive: Primitive, props: Props = {}) {
  const mesh = primitive.instance
  if (!(mesh instanceof Mesh))
    return
  mesh.castShadow = bool(props.castShadow) ?? mesh.castShadow
  mesh.receiveShadow = bool(props.receiveShadow) ?? mesh.receiveShadow
  if (mesh.material instanceof MeshStandardMaterial) {
    const color = str(props.color)
    if (color)
      mesh.material.color.set(color)
    mesh.material.roughness = num(props.roughness) ?? mesh.material.roughness
    mesh.material.metalness = num(props.metalness) ?? mesh.material.metalness
    mesh.material.wireframe = bool(props.wireframe) ?? false
  }
}

/** Only some lights have a shadow */
function shadowOf(light: Light): LightShadow | undefined {
  return (light as Light & { shadow?: LightShadow }).shadow
}

function lightProps(light: LightPrimitive): Props {
  const instance: Light = light.instance
  const props: Props = {
    color: `#${instance.color.getHexString()}`,
    intensity: instance.intensity,
    castShadow: instance.castShadow,
  }

  const shadow = shadowOf(instance)
  if (instance.castShadow && shadow) {
    props.shadowMapSize = shadow.mapSize.x
    if (shadow.camera instanceof OrthographicCamera) {
      props.shadowArea = shadow.camera.right
      props.shadowFar = shadow.camera.far
    }
  }
  return props
}

function applyLightProps(light: LightPrimitive, props: Props = {}) {
  const color = str(props.color)
  if (color)
    light.instance.color.set(color)
  light.instance.intensity = num(props.intensity) ?? light.instance.intensity
  light.instance.castShadow = bool(props.castShadow) ?? light.instance.castShadow

  const shadow = shadowOf(light.instance)
  if (!shadow)
    return

  const mapSize = num(props.shadowMapSize)
  if (mapSize)
    shadow.mapSize.set(mapSize, mapSize)

  // Directional lights: the half size of the area that gets shadows, and how far from the light
  const camera = shadow.camera
  if (camera instanceof OrthographicCamera) {
    const area = num(props.shadowArea)
    if (area) {
      camera.left = -area
      camera.right = area
      camera.top = area
      camera.bottom = -area
    }
    camera.far = num(props.shadowFar) ?? camera.far
    camera.updateProjectionMatrix()
  }
}

/**
 * A loaded GLTF model placed in the scene
 */
export class ModelObject extends GameObject {
  instance: Group
  readonly resource: string

  constructor(resource: string, gltf: GLTF) {
    super()
    this.resource = resource
    this.instance = clone(gltf.scene) as Group
    Game.instance().scene.add(this.instance)
  }

  setShadows(cast: boolean, receive: boolean) {
    this.instance.traverse((o) => {
      if (o instanceof Mesh) {
        o.castShadow = cast
        o.receiveShadow = receive
      }
    })
  }

  get castShadow() {
    let cast = false
    this.instance.traverse(o => (cast ||= o instanceof Mesh && o.castShadow))
    return cast
  }

  get receiveShadow() {
    let receive = false
    this.instance.traverse(o => (receive ||= o instanceof Mesh && o.receiveShadow))
    return receive
  }

  update(_delta: number): void {}

  destroy(): void {
    Game.instance().scene.remove(this.instance)
    super.destroy()
  }
}

let registered = false

export function registerBuiltinSceneObjects() {
  if (registered)
    return
  registered = true

  for (const [name, PrimitiveClass] of Object.entries(PRIMITIVE_REGISTRY)) {
    registerSceneObject<Primitive>({
      type: primitiveType(name),
      label: name,
      client(data) {
        const position = new Vector3(...data.transform.position)
        const primitive = PrimitiveClass === PlanePrimitive
          ? new PlanePrimitive(position, num(data.props?.width) ?? 1, num(data.props?.height) ?? 1)
          : new PrimitiveClass(position)
        applyPrimitiveProps(primitive, data.props)
        return primitive
      },
      serialize: primitiveProps,
    })
  }

  for (const [name, LightClass] of Object.entries(LIGHT_REGISTRY)) {
    registerSceneObject<LightPrimitive>({
      type: lightType(name),
      label: name,
      client(data) {
        const light = new LightClass(new Vector3(...data.transform.position))
        applyLightProps(light, data.props)
        return light
      },
      serialize: lightProps,
    })
  }

  registerSceneObject<ModelObject>({
    type: MODEL_TYPE,
    label: 'Model',
    client(data) {
      const resource = str(data.props?.resource)
      const gltf = resource ? Game.instance().resources.items[resource] : undefined
      if (!resource || !gltf || !('scene' in gltf))
        throw new Error(`Model needs the name of a loaded gltfModel resource in props.resource, got "${resource}"`)

      const model = new ModelObject(resource, gltf as GLTF)
      model.setShadows(bool(data.props?.castShadow) ?? true, bool(data.props?.receiveShadow) ?? true)
      return model
    },
    serialize: model => ({ resource: model.resource, castShadow: model.castShadow, receiveShadow: model.receiveShadow }),
  })

  registerSceneObjectResolver((type) => {
    if (!type.startsWith('prefab:'))
      return undefined

    const key = type.slice('prefab:'.length)
    const prefab = getPrefab(key)
    if (!prefab)
      return undefined

    return {
      type,
      label: prefab.label ?? prefab.name,
      plugin: prefab.plugin,
      client(data) {
        const result = spawnPrefab(key, new Vector3(...data.transform.position))
        if (result?.clearPanes)
          Game.instance().editor?.trigger('prefabPanesCleared')
        if (result?.addBindings)
          Game.instance().editor?.trigger('prefabCreated', { label: prefab.label ?? prefab.name, addBindings: result.addBindings })
        return result?.object
      },
    }
  })
}
