import type { World } from '@dimforge/rapier3d-compat'
import type { PrimitiveDefinition, PrimitiveOptions } from '../Prefab/Primitives/definitions'
import type { SceneObjectData } from './types'
import { Euler, Quaternion, Vector3 } from 'three'
import BaseGame from '../BaseGame'
import { PrimitiveCollider } from '../Prefab/Primitives/collider'
import { buildPrimitiveGeometry, PRIMITIVE_DEFINITIONS, primitiveCollides, resolveParams } from '../Prefab/Primitives/definitions'
import GameObject from '../World/GameObject'
import { registerSceneObject } from './SceneObjectRegistry'

/*
 * The parts of the built-in primitives that both sides share. No rendering, so the server can import it.
 */

export function primitiveType(name: string) {
  return `Primitive:${name}`
}

/** A primitive's pivot and collision from its saved props. Collision is on unless turned off */
export function primitiveOptionsFromProps(props: Record<string, unknown> = {}): Required<PrimitiveOptions> {
  return {
    pivot: props.pivot === 'base'
      ? 'base'
      : 'center',
    collision: props.collision !== false,
  }
}

/**
 * A primitive on the server: only its collider, built from the same geometry the client renders
 */
export class PrimitiveBody extends GameObject {
  readonly collider: PrimitiveCollider

  constructor(world: World, definition: PrimitiveDefinition, data: SceneObjectData) {
    const { pivot } = primitiveOptionsFromProps(data.props)
    const position = new Vector3(...data.transform.position)
    super(undefined, position)

    const geometry = buildPrimitiveGeometry(definition, resolveParams(definition, data.props), pivot)
    this.collider = new PrimitiveCollider(world, geometry, {
      position,
      quaternion: new Quaternion().setFromEuler(new Euler(...data.transform.rotation)),
      scale: new Vector3(...data.transform.scale),
    })
    geometry.dispose()
  }

  update(_delta: number): void {}

  destroy(): void {
    this.collider.destroy()
    super.destroy()
  }
}

let registered = false

/** Gives every built-in primitive a `server` factory that adds its collider */
export function registerPrimitiveServerObjects() {
  if (registered)
    return
  registered = true

  for (const [name, definition] of Object.entries(PRIMITIVE_DEFINITIONS)) {
    registerSceneObject<PrimitiveBody>({
      type: primitiveType(name),
      label: name,
      server(data) {
        const world = BaseGame.instance().physicsWorld
        if (!world || !primitiveCollides(definition, primitiveOptionsFromProps(data.props).collision))
          return
        return new PrimitiveBody(world, definition, data)
      },
    })
  }
}
