import type { Material, Mesh } from 'three'
import type { GLTF } from 'three/examples/jsm/Addons.js'
import Game from '@mavonengine/core/Game'
import GameObject from '@mavonengine/core/World/GameObject'
import { InstancedMesh, Object3D, Vector3 } from 'three'
import { clone } from 'three/examples/jsm/utils/SkeletonUtils.js'
import Tree from './Vegetation/Tree'

export default class Trees extends GameObject {
  private instancedMeshes: InstancedMesh[] = []
  private trees: Tree[] = []

  constructor(positions: number[], scales: number[], rotations: number[]) {
    super()

    const count = positions.length / 3

    // Create one physics collider per tree position
    for (let i = 0; i < count; i++) {
      this.trees.push(new Tree(new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2])))
    }

    const onLoad = () => {
      const scene = clone((Game.instance().resources.items.pine as GLTF).scene)

      const meshes: Mesh[] = []
      scene.traverse((child) => {
        if ((child as Mesh).isMesh) {
          meshes.push(child as Mesh)
        }
      })

      if (meshes.length === 0) {
        console.error('No meshes found in pine model')
        return
      }

      const dummy = new Object3D()

      for (const sourceMesh of meshes) {
        sourceMesh.geometry.rotateX((90 * Math.PI) / 180)

        const instancedMesh = new InstancedMesh(
          sourceMesh.geometry,
          sourceMesh.material as Material,
          count,
        )

        for (let i = 0; i < count; i++) {
          dummy.position.set(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!)
          dummy.rotation.set(rotations[i * 3]!, rotations[i * 3 + 1]!, rotations[i * 3 + 2]!)
          dummy.scale.setScalar(scales[i * 3]!)
          dummy.updateMatrix()
          instancedMesh.setMatrixAt(i, dummy.matrix)
        }

        instancedMesh.instanceMatrix.needsUpdate = true
        instancedMesh.castShadow = true
        instancedMesh.receiveShadow = true

        this.instancedMeshes.push(instancedMesh)
        Game.instance().scene.add(instancedMesh)
      }
    }

    const resources = Game.instance().resources
    if (resources.loaded)
      onLoad()
    else
      resources.on('loaded', onLoad)
  }

  update(_dt: number) {}

  destroy(): void {
    for (const mesh of this.instancedMeshes) {
      mesh.dispose()
      Game.instance().scene.remove(mesh)
    }
    this.trees.forEach(tree => tree.destroy())
  }
}
