import Game from '../Game'
import BaseWorld from './BaseWorld'
import Environment from './Environment'

export default class World extends BaseWorld {
  environment: Environment

  constructor() {
    super()

    this.environment = new Environment()

    const worldDebug = Game.instance().debug.ui?.addFolder({ title: 'World' })

    if (worldDebug) {
      worldDebug.addBinding(this.entities, 'length', {
        label: 'Entities',
        readonly: true,
      })

      const debugProxy = {
        get chunkCount() {
          return Game.instance().world.chunkManager.loadedChunks.size
        },
      }

      worldDebug.addBinding(debugProxy, 'chunkCount', {
        label: 'Chunks',
        readonly: true,
      })
    }
  }
}
