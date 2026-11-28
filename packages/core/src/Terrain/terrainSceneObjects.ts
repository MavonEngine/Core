import type { Collider, World } from '@dimforge/rapier3d-compat'
import type { SceneObjectData } from '../Scene/types'
import { Euler, Matrix4, Quaternion, Vector3 } from 'three'
import BaseGame from '../BaseGame'
import { buildScatterColliders, removeColliders, SCATTER_TYPE, scatterPropsFrom } from '../Scatter/scatterData'
import { registerSceneObject } from '../Scene/SceneObjectRegistry'
import GameObject from '../World/GameObject'
import { TerrainCollider } from './TerrainCollider'
import { Heightmap, TERRAIN_TYPE, terrainPropsFrom } from './terrainData'

/*
 * The server side of terrains and scatter layers: their colliders, built from the scene's data. No rendering.
 */

/** A terrain on the server: its heightfield collider */
export class TerrainBody extends GameObject {
  readonly collider: TerrainCollider
  readonly heightmap: Heightmap

  constructor(world: World, data: SceneObjectData) {
    const position = new Vector3(...data.transform.position)
    super(undefined, position)
    this.heightmap = Heightmap.fromProps(terrainPropsFrom(data.props))
    this.collider = new TerrainCollider(world, this.heightmap, {
      position,
      quaternion: new Quaternion().setFromEuler(new Euler(...data.transform.rotation)),
      scale: new Vector3(...data.transform.scale),
    })
  }

  update(_delta: number): void {}

  destroy(): void {
    this.collider.destroy()
    super.destroy()
  }
}

/** A scatter layer on the server: a collider per instance of the groups that collide */
export class ScatterBody extends GameObject {
  readonly colliders: Collider[]

  constructor(private readonly world: World, data: SceneObjectData) {
    super()
    const { position, rotation, scale } = data.transform
    const base = new Matrix4().compose(
      new Vector3(...position),
      new Quaternion().setFromEuler(new Euler(...rotation)),
      new Vector3(...scale),
    )
    this.colliders = buildScatterColliders(world, scatterPropsFrom(data.props), base)
  }

  update(_delta: number): void {}

  destroy(): void {
    removeColliders(this.world, this.colliders)
    super.destroy()
  }
}

let registered = false

/** Gives terrains and scatter layers their `server` factories */
export function registerTerrainServerObjects() {
  if (registered)
    return
  registered = true

  registerSceneObject<TerrainBody>({
    type: TERRAIN_TYPE,
    label: 'Terrain',
    server(data) {
      const world = BaseGame.instance().physicsWorld
      if (!world || !terrainPropsFrom(data.props).collision)
        return
      return new TerrainBody(world, data)
    },
  })

  registerSceneObject<ScatterBody>({
    type: SCATTER_TYPE,
    label: 'Scatter layer',
    server(data) {
      const world = BaseGame.instance().physicsWorld
      if (!world)
        return
      return new ScatterBody(world, data)
    },
  })
}
