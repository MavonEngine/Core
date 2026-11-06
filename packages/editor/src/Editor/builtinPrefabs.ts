import type { GLTF } from 'three/examples/jsm/loaders/GLTFLoader.js'
import Game from '@mavonengine/core/Game'
import Grass from '@mavonengine/core/Prefab/Grass/Grass'
import { registerPrefab } from '@mavonengine/core/Prefab/PrefabRegistry'
import Water from '@mavonengine/core/Prefab/Water/Water'
import WaterManager from '@mavonengine/core/Prefab/Water/WaterManager'

/**
 * Register the prefabs that come with the engine. Plugins add theirs with `ctx.registerPrefab()`.
 */
export function registerBuiltinPrefabs() {
  registerPrefab({
    name: 'Water',
    spawn(position) {
      const isFirst = !WaterManager.instance
      if (isFirst)
        WaterManager.init()

      const water = new Water(position, 20)
      WaterManager.instance!.waters.push(water)

      // One pane controls every water surface, so it is only added for the first
      return {
        object: water,
        addBindings: isFirst ? WaterManager.instance!.addBindings.bind(WaterManager.instance!) : undefined,
      }
    },
  })

  registerPrefab({
    name: 'Grass',
    spawn(position) {
      const grassGltfs = Object.entries(Game.instance().resources.items)
        .filter(([k, v]) => 'scene' in v && k.toLowerCase().includes('grass'))

      if (grassGltfs.length < 2) {
        Game.instance().logger?.warn('Grass prefab requires two GLTF resources with "grass" in their name')
        return null
      }

      const grass = new Grass(grassGltfs[0][1] as GLTF, grassGltfs[1][1] as GLTF, 10000, 12.5, position)
      return { object: grass, addBindings: grass.addBindings.bind(grass), clearPanes: true }
    },
  })
}
