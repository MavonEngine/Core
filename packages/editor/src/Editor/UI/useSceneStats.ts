import type { Material } from 'three'
import { useEffect, useState } from 'react'
import { Mesh } from 'three'

interface SceneStats {
  fps: number
  triangles: number
  drawCalls: number
  objects: number
  materials: number
  textures: number
}

export function useSceneStats(intervalMs = 500): SceneStats {
  const [stats, setStats] = useState<SceneStats>({
    fps: 0,
    triangles: 0,
    drawCalls: 0,
    objects: 0,
    materials: 0,
    textures: 0,
  })

  useEffect(() => {
    const id = setInterval(() => {
      const game = window.Game
      if (!game)
        return

      const info = game.renderer.instance.info

      let objectCount = 0
      const materialSet = new Set<Material>()
      game.scene.traverse((obj) => {
        objectCount++
        if (obj instanceof Mesh) {
          if (Array.isArray(obj.material)) {
            obj.material.forEach(m => materialSet.add(m))
          }
          else if (obj.material) {
            materialSet.add(obj.material)
          }
        }
      })

      setStats({
        fps: game.renderer.fps,
        triangles: info.render.triangles,
        drawCalls: info.render.calls,
        objects: objectCount,
        materials: materialSet.size,
        textures: info.memory.textures,
      })
    }, intervalMs)

    return () => clearInterval(id)
  }, [intervalMs])

  return stats
}
