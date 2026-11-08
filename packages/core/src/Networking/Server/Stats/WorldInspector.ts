import type BaseGame from '../../../BaseGame'
import type { EntityDetail, EntityList, EntityQuery, SceneInfo } from '../../../Dev/inspect'
import process from 'node:process'
import { describeScene, detailEntity, queryEntities, summarizeEntity } from '../../../Dev/inspect'
import Player from '../../Entities/Player'

export type { EntityDetail, EntityList, EntityQuery, EntitySummary, SceneObjectInfo } from '../../../Dev/inspect'
export { DEFAULT_ENTITY_LIMIT, MAX_ENTITY_LIMIT } from '../../../Dev/inspect'

/**
 * Whether the dev inspection endpoints (GET /api/game/dev/*) are served.
 * Only outside production: a metrics token does not turn them on there.
 */
export function devEndpointsEnabled(env: Record<string, string | undefined> = process.env) {
  return env.NODE_ENV !== 'production'
}

export interface ServerSceneInfo extends SceneInfo {
  /** Scene file on disk, when it was opened with `server.openScene()` */
  file: string | null
  /** Reloaded when the file changes */
  watching: boolean
}

export interface WorldInspectorSource {
  game: BaseGame
  /** File of the active scene, if the server opened it from one */
  readonly activeSceneFile?: string
  readonly sceneWatched: boolean
}

const isPlayer = (entity: unknown) => entity instanceof Player

/**
 * Read-only views of the server's scene and the entities in its world, served on the dev endpoints.
 */
export default class WorldInspector {
  constructor(private source: WorldInspectorSource) { }

  scene(): ServerSceneInfo | null {
    const scene = this.source.game.activeScene
    if (!scene)
      return null

    return {
      ...describeScene(scene),
      file: this.source.activeSceneFile ?? null,
      watching: this.source.sceneWatched,
    }
  }

  entities(query: EntityQuery = {}): EntityList {
    const { world, activeScene } = this.source.game
    return queryEntities(Array.from(world.entities.items.values(), entity => summarizeEntity(entity, activeScene, isPlayer)), query)
  }

  entity(id: string): EntityDetail | null {
    const entity = this.source.game.world.entities.items.get(id)
    return entity ? detailEntity(entity, this.source.game.activeScene, isPlayer) : null
  }
}
