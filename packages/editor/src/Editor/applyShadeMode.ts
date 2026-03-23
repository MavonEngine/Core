import type { Material, Object3D } from 'three'
import type { ShadeMode } from '../Editor'
import { Mesh, MeshBasicMaterial } from 'three'

export function applyShadeMode(
  root: Object3D,
  mode: ShadeMode,
  originalMaterials: Map<string, Material | Material[]>,
  shadeOverrideMaterials: Map<string, MeshBasicMaterial>,
  flatColors: Map<string, number>,
) {
  root.traverse((child) => {
    if (!(child instanceof Mesh))
      return

    if (mode === 'solid') {
      shadeOverrideMaterials.get(child.uuid)?.dispose()
      shadeOverrideMaterials.delete(child.uuid)

      const original = originalMaterials.get(child.uuid)
      if (original) {
        child.material = original
        originalMaterials.delete(child.uuid)
      }
    }
    else {
      if (!originalMaterials.has(child.uuid))
        originalMaterials.set(child.uuid, child.material)

      shadeOverrideMaterials.get(child.uuid)?.dispose()

      if (!flatColors.has(child.uuid))
        flatColors.set(child.uuid, Math.random() * 0xFFFFFF)

      const color = flatColors.get(child.uuid)
      const mat = new MeshBasicMaterial(
        mode === 'wireframe' ? { wireframe: true, color } : { color },
      )
      shadeOverrideMaterials.set(child.uuid, mat)
      child.material = mat
    }
  })
}
