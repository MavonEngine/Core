import type { Group, Light, LightShadow } from 'three'
import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import type { LogicGraphProps, LogicGraphSide } from '../Graph/Logic/logicGraphObject'
import type { LightPrimitive } from '../Prefab/Lights/index'
import type { Primitive } from '../Prefab/Primitives/index'
import type GameScene from './GameScene'
import type { SceneObjectData } from './types'
import { Mesh, MeshStandardMaterial, OrthographicCamera, Vector3 } from 'three'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import { WithEditorHelper } from '../Editor/WithEditorHelper'
import Game from '../Game'
import { LOGIC_GRAPH_TYPE, LogicGraphObject, runsOn } from '../Graph/Logic/logicGraphObject'
import { materialGraphs } from '../Graph/Material/MaterialGraphs'
import { LIGHT_REGISTRY } from '../Prefab/Lights/index'
import { getPrefab, spawnPrefab } from '../Prefab/PrefabRegistry'
import { PRIMITIVE_REGISTRY } from '../Prefab/Primitives/index'
import GameObject from '../World/GameObject'
import { primitiveOptionsFromProps, primitiveType } from './primitiveSceneObjects'
import { registerSceneObject, registerSceneObjectResolver } from './SceneObjectRegistry'

/**
 * The client side of the scene object types that come with the engine. None of them exist on the server,
 * they are visuals only; a project registers `server` factories for what the server needs.
 *
 * - `Primitive:<Box|Sphere|…>` props: color, roughness, metalness, wireframe, castShadow, receiveShadow, materialGraph, plus the primitive's
 *   geometry params (see PRIMITIVE_DEFINITIONS, e.g. width/height/depth for Box, radius for Sphere) pivot ('center' | 'base') and collision.
 *   Missing params use their defaults, a missing pivot is 'center', collision is on unless false.
 *   The server builds their colliders, see primitiveSceneObjects
 * - `Light:<AmbientLight|DirectionalLight|…>` props: color, intensity, castShadow, shadowMapSize (+ shadowArea, shadowFar for directional lights)
 * - `Model` props: resource (name of a loaded gltfModel), castShadow, receiveShadow
 * - `prefab:<key>` any prefab of the prefab registry, by its key
 * - `LogicGraph` props: graph, side ('client' | 'server' | 'both'), target, parameters. Runs a logic graph, see
 *   Graph/Logic/logicGraphObject (which the server registers too)
 */

export { primitiveType } from './primitiveSceneObjects'

export function lightType(name: string) {
  return `Light:${name}`
}

export const MODEL_TYPE = 'Model'

export function prefabType(key: string) {
  return `prefab:${key}`
}

type Props = Record<string, unknown>

function str(v: unknown) {
  return typeof v === 'string'
    ? v
    : undefined
}
function num(v: unknown) {
  return typeof v === 'number' && Number.isFinite(v)
    ? v
    : undefined
}
function bool(v: unknown) {
  return typeof v === 'boolean'
    ? v
    : undefined
}

function primitiveProps(primitive: Primitive): Props {
  const props: Props = { ...primitive.params, pivot: primitive.pivot, collision: primitive.collision }
  const mesh = primitive.instance
  if (mesh instanceof Mesh) {
    props.castShadow = mesh.castShadow
    props.receiveShadow = mesh.receiveShadow
    const material = primitive.baseMaterial
    if (material instanceof MeshStandardMaterial) {
      props.color = `#${material.color.getHexString()}`
      props.roughness = material.roughness
      props.metalness = material.metalness
      if (material.wireframe)
        props.wireframe = true
    }
    if (primitive.materialGraph)
      props.materialGraph = primitive.materialGraph
  }
  return props
}

function applyPrimitiveProps(primitive: Primitive, props: Props = {}) {
  const mesh = primitive.instance
  if (!(mesh instanceof Mesh))
    return
  mesh.castShadow = bool(props.castShadow) ?? mesh.castShadow
  mesh.receiveShadow = bool(props.receiveShadow) ?? mesh.receiveShadow
  const material = primitive.baseMaterial
  if (material instanceof MeshStandardMaterial) {
    const color = str(props.color)
    if (color)
      material.color.set(color)
    material.roughness = num(props.roughness) ?? material.roughness
    material.metalness = num(props.metalness) ?? material.metalness
    material.wireframe = bool(props.wireframe) ?? false
  }
  primitive.setMaterialGraph(str(props.materialGraph))
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

const SIDES: LogicGraphSide[] = ['client', 'server', 'both']

/**
 * A logic graph on the client, with an editor helper to select, move and set it up by. It runs here only when its
 * side includes the client, but is always built so the editor shows it
 */
class ClientLogicGraph extends WithEditorHelper(LogicGraphObject) {
  constructor(data: SceneObjectData, scene: GameScene | undefined) {
    const props = data.props as LogicGraphProps | undefined
    // Not running on this side: no graph to load
    super(runsOn(props?.side, 'client')
      ? data
      : {
          ...data,
          props: { ...props, graph: undefined },
        }, scene, 'client')
    this.props.graph = props?.graph

    const setProp = (changes: Partial<LogicGraphProps>) => this.scene?.setProps(this.id, {
      ...this.props,
      ...changes,
    })
    this.registerEditorHelper(this.position.clone(), `Logic: ${props?.graph || 'no graph'}`, {
      onMove: delta => this.position.add(delta),
      properties: [
        {
          type: 'select',
          label: 'graph',
          options: () => [
            { value: '', label: 'None' },
            ...materialGraphs.list.filter(graph => graph.kind === 'logic' && !graph.function).map(graph => ({ value: graph.name, label: graph.name })),
          ],
          getValue: () => this.props.graph ?? '',
          setValue: v => setProp({ graph: v || undefined }),
          refresh: () => materialGraphs.refreshList(),
        },
        {
          type: 'select',
          label: 'runs on',
          options: () => SIDES.map(side => ({ value: side, label: side })),
          getValue: () => this.props.side ?? 'client',
          setValue: v => setProp({ side: v as LogicGraphSide }),
        },
        {
          type: 'select',
          label: 'self',
          options: () => [
            { value: '', label: 'This object' },
            ...(this.scene?.getEntries() ?? [])
              .filter(entry => entry.data.id !== this.id)
              .map(entry => ({ value: entry.data.id, label: entry.data.name ?? entry.data.id })),
          ],
          getValue: () => this.props.target ?? '',
          setValue: v => setProp({ target: v || undefined }),
        },
      ],
    })
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
        const primitive = new PrimitiveClass(position, data.props as Record<string, number> | undefined, primitiveOptionsFromProps(data.props))
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
      const gltf = resource
        ? Game.instance().resources.items[resource]
        : undefined
      if (!resource || !gltf || !('scene' in gltf))
        throw new Error(`Model needs the name of a loaded gltfModel resource in props.resource, got "${resource}"`)

      const model = new ModelObject(resource, gltf as GLTF)
      model.setShadows(bool(data.props?.castShadow) ?? true, bool(data.props?.receiveShadow) ?? true)
      return model
    },
    serialize: model => ({ resource: model.resource, castShadow: model.castShadow, receiveShadow: model.receiveShadow }),
  })

  registerSceneObject<ClientLogicGraph>({
    type: LOGIC_GRAPH_TYPE,
    label: 'Logic Graph',
    client: (data, { scene }) => new ClientLogicGraph(data, scene),
    serialize: object => ({ ...object.props }),
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
