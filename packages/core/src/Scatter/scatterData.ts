import type { Collider, World } from '@dimforge/rapier3d-compat'
import RAPIER from '@dimforge/rapier3d-compat'
import { Matrix4, Quaternion, Vector3 } from 'three'
import { decodeFloat32, encodeFloat32 } from '../Terrain/codec'

/*
 * Assets painted onto the scene with a scatter brush, without anything that renders them, so the server can give
 * them colliders. One ScatterLayer object holds a group of instances per asset, in world space.
 */

/** Scene object type of a scatter layer */
export const SCATTER_TYPE = 'ScatterLayer'

/** Floats per instance: position (3), rotation as a quaternion (4), scale (3) */
export const INSTANCE_STRIDE = 10

export type ScatterColliderShape = 'none' | 'box' | 'cylinder' | 'sphere'

/** A collider in the asset's own space, scaled and turned with each instance */
export interface ScatterCollider {
  shape: ScatterColliderShape
  center: [number, number, number]
  /** Box: half extents. Cylinder: [radius, half height, radius]. Sphere: [radius, radius, radius] */
  halfSize: [number, number, number]
}

export interface ScatterGroup {
  /** Name of the gltfModel resource */
  asset: string
  /** Off to let players walk through this asset, e.g. grass and ferns */
  collision: boolean
  collider?: ScatterCollider
  castShadow: boolean
  receiveShadow: boolean
  /** The instances, INSTANCE_STRIDE floats each */
  instances: number[]
}

export interface ScatterLayerProps {
  groups: ScatterGroup[]
  /** Off to turn off the colliders of every group, e.g. for a decoration layer */
  collision: boolean
}

/** One placed instance */
export interface ScatterInstance {
  position: Vector3
  quaternion: Quaternion
  scale: Vector3
}

function vec3(v: unknown, fallback: [number, number, number]): [number, number, number] {
  return Array.isArray(v) && v.length === 3 && v.every(n => typeof n === 'number' && Number.isFinite(n))
    ? [v[0], v[1], v[2]]
    : fallback
}

const SHAPES: ScatterColliderShape[] = ['none', 'box', 'cylinder', 'sphere']

function colliderFrom(v: unknown): ScatterCollider | undefined {
  if (!v || typeof v !== 'object')
    return undefined
  const raw = v as Partial<ScatterCollider>
  return {
    shape: SHAPES.includes(raw.shape as ScatterColliderShape)
      ? raw.shape!
      : 'box',
    center: vec3(raw.center, [0, 0.5, 0]),
    halfSize: vec3(raw.halfSize, [0.5, 0.5, 0.5]),
  }
}

/** A scatter layer's props from its saved ones; broken groups are left out */
export function scatterPropsFrom(props: Record<string, unknown> = {}): ScatterLayerProps {
  const groups = Array.isArray(props.groups)
    ? props.groups.flatMap((g): ScatterGroup[] => {
        if (!g || typeof g !== 'object' || typeof g.asset !== 'string' || !g.asset)
          return []
        let instances: number[] = []
        try {
          if (typeof g.instances === 'string' && g.instances) {
            const floats = decodeFloat32(g.instances)
            instances = Array.from(floats.subarray(0, floats.length - floats.length % INSTANCE_STRIDE))
          }
        }
        catch {
          // Broken data: the group is kept without instances
        }
        return [
          {
            asset: g.asset,
            collision: g.collision !== false,
            collider: colliderFrom(g.collider),
            castShadow: g.castShadow !== false,
            receiveShadow: g.receiveShadow !== false,
            instances,
          },
        ]
      })
    : []
  return { groups, collision: props.collision !== false }
}

/** The props to save. Instances are encoded, empty groups dropped */
export function serializeScatterProps(props: ScatterLayerProps): Record<string, unknown> {
  return {
    collision: props.collision,
    groups: props.groups.filter(g => g.instances.length).map(g => ({
      asset: g.asset,
      collision: g.collision,
      ...(g.collider
        ? { collider: g.collider }
        : {}),
      castShadow: g.castShadow,
      receiveShadow: g.receiveShadow,
      instances: encodeFloat32(Float32Array.from(g.instances)),
    })),
  }
}

export function instanceCount(group: Pick<ScatterGroup, 'instances'>): number {
  return group.instances.length / INSTANCE_STRIDE
}

export function readInstance(group: Pick<ScatterGroup, 'instances'>, index: number, out: ScatterInstance = {
  position: new Vector3(),
  quaternion: new Quaternion(),
  scale: new Vector3(),
}): ScatterInstance {
  const d = group.instances
  const i = index * INSTANCE_STRIDE
  out.position.set(d[i], d[i + 1], d[i + 2])
  out.quaternion.set(d[i + 3], d[i + 4], d[i + 5], d[i + 6])
  out.scale.set(d[i + 7], d[i + 8], d[i + 9])
  return out
}

export function pushInstance(group: Pick<ScatterGroup, 'instances'>, instance: ScatterInstance): void {
  const { position: p, quaternion: q, scale: s } = instance
  group.instances.push(p.x, p.y, p.z, q.x, q.y, q.z, q.w, s.x, s.y, s.z)
}

/**
 * The collider of an asset from its bounds: `fit` of the box (1 is the whole box). A cylinder stands on the bottom of
 * the bounds, so a fit of 0.2 is a tree's trunk
 */
export function colliderFromBounds(shape: ScatterColliderShape, fit: number, min: [number, number, number], max: [number, number, number]): ScatterCollider {
  const f = Math.max(0.01, fit)
  const center: [number, number, number] = [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2]
  const half: [number, number, number] = [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2]
  switch (shape) {
    case 'cylinder': {
      const radius = Math.min(half[0], half[2]) * f
      return {
        shape,
        center,
        halfSize: [radius, half[1], radius],
      }
    }
    case 'sphere': {
      const radius = Math.max(...half) * f
      return {
        shape,
        center,
        halfSize: [radius, radius, radius],
      }
    }
    default:
      return {
        shape,
        center,
        halfSize: [half[0] * f, half[1] * f, half[2] * f],
      }
  }
}

function colliderDesc(collider: ScatterCollider, scale: Vector3): RAPIER.ColliderDesc | undefined {
  const [hx, hy, hz] = collider.halfSize
  const sx = Math.abs(scale.x)
  const sy = Math.abs(scale.y)
  const sz = Math.abs(scale.z)
  switch (collider.shape) {
    case 'box':
      return RAPIER.ColliderDesc.cuboid(hx * sx, hy * sy, hz * sz)
    case 'cylinder':
      return RAPIER.ColliderDesc.cylinder(hy * sy, hx * Math.max(sx, sz))
    case 'sphere':
      return RAPIER.ColliderDesc.ball(hx * Math.max(sx, sy, sz))
    default:
      return undefined
  }
}

/**
 * Fixed colliders for every instance of the groups that collide, placed by the layer's own transform (`base`).
 * The client and the server build the same ones
 */
export function buildScatterColliders(world: World, props: ScatterLayerProps, base?: Matrix4): Collider[] {
  if (!props.collision)
    return []
  const colliders: Collider[] = []
  const instance: ScatterInstance = {
    position: new Vector3(),
    quaternion: new Quaternion(),
    scale: new Vector3(),
  }
  const offset = new Vector3()
  const matrix = new Matrix4()
  for (const group of props.groups) {
    const shape = group.collider
    if (!group.collision || !shape || shape.shape === 'none')
      continue
    for (let i = 0; i < instanceCount(group); i++) {
      readInstance(group, i, instance)
      if (base) {
        matrix.compose(instance.position, instance.quaternion, instance.scale).premultiply(base)
        matrix.decompose(instance.position, instance.quaternion, instance.scale)
      }
      const desc = colliderDesc(shape, instance.scale)
      if (!desc)
        continue
      offset.set(...shape.center).multiply(instance.scale).applyQuaternion(instance.quaternion).add(instance.position)
      const q = instance.quaternion
      desc.setTranslation(offset.x, offset.y, offset.z).setRotation({ x: q.x, y: q.y, z: q.z, w: q.w })
      colliders.push(world.createCollider(desc))
    }
  }
  return colliders
}

export function removeColliders(world: World, colliders: Collider[]): void {
  for (const collider of colliders)
    world.removeCollider(collider, false)
  colliders.length = 0
}
