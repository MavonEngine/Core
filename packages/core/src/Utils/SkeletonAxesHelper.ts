import { AxesHelper, Bone, Material, Object3D } from 'three'

/**
 * https://mattrossman.com/2024/07/10/visualizing-threejs-bone-orientations/
 */
export default class SkeletonAxesHelper extends Object3D {
  bones: Bone[]
  axesHelpers: AxesHelper[]

  constructor(object: Object3D, size = 0.05) {
    super()

    this.bones = []
    this.axesHelpers = []

    object.traverse((object) => {
      if (object instanceof Bone) {
        this.bones.push(object)
      }
    })

    for (let i = 0; i < this.bones.length; i++) {
      const axesHelper = new AxesHelper(size)

      if (!(axesHelper.material instanceof Material)) {
        throw new TypeError('Invalid material')
      }

      axesHelper.material.transparent = true
      axesHelper.material.depthTest = false

      axesHelper.matrixAutoUpdate = false

      this.axesHelpers.push(axesHelper)
      this.add(axesHelper)
    }
  }

  updateMatrixWorld(force: boolean) {
    for (let i = 0; i < this.bones.length; i++) {
      const bone = this.bones[i]
      const axesHelper = this.axesHelpers[i]

      axesHelper.matrix.copy(bone.matrixWorld)
    }

    super.updateMatrixWorld(force)
  }

  dispose() {
    for (let i = 0; i < this.axesHelpers.length; i++) {
      this.axesHelpers[i].dispose()
    }
  }
}
