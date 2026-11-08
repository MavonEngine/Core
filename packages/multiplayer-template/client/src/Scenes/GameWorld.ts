import type {
  Material,
} from 'three'
import Game from '@mavonengine/core/Game'
import GameObject from '@mavonengine/core/World/GameObject'
import {
  GridHelper,
  Vector3,
} from 'three'
import Character from '../Entities/Player'
import GameSyncManager from '../GameSyncManager'
import NetworkManager from '../NetworkManager'
import PlayerController from '../PlayerController'

export default class GameWorld extends GameObject {
  /** Null while the editor watches the game */
  player: Character | null = null
  playerController: PlayerController | null = null
  gameSyncManager: GameSyncManager
  private updateCallback?: (delta: number) => void

  /**
   * @param spectate connect without a player, for the editor. The server sends everything, but nobody sees us
   */
  constructor(spectate = false) {
    super()

    this.setupGrid()

    if (!spectate) {
      // Local player box (green)
      this.player = new Character('localPlayer', true, new Vector3(0, 0.5, 0))
      this.playerController = new PlayerController(this.player)
      Game.instance().world.add({ PlayerController: this.playerController })
    }

    this.gameSyncManager = new GameSyncManager(new NetworkManager(), this.playerController)

    this.updateCallback = delta => this.update(delta)
    Game.instance().onUpdate(this.updateCallback)

    // The editor is no player: the server drops ours, so drop the local one and its camera controls too.
    // The connection stays, so the trees and other players the server sends keep showing in the editor
    Game.instance().on('editorBoot', () => this.leaveForEditor())
  }

  private leaveForEditor() {
    const world = Game.instance().world.entities.items
    for (const [id, entity] of world) {
      if (entity === this.playerController) {
        world.delete(id)
        this.playerController.destroy()
      }
    }
    this.player?.destroy()
    this.player = null
    this.playerController = null
    this.gameSyncManager.playerController = null
  }

  /**
   * The sky, lights and ground come from scenes/main.json. The grid is a visual aid only, so it isn't part of the scene
   */
  private setupGrid() {
    const grid = new GridHelper(200, 40, 0x000000, 0x000000)
    const gridMat = grid.material as Material
    gridMat.opacity = 0.5
    gridMat.transparent = true
    gridMat.depthWrite = false
    grid.renderOrder = -1
    Game.instance().scene.add(grid)
  }

  update(delta: number): void {
    // PlayerController is in world.entities so its update() (and player.update()) is
    // already called by the engine world loop. We only need to tick the sync manager.
    this.gameSyncManager.update(delta)
  }

  destroy(): void {
    Game.instance().unregisterOnUpdate(this.updateCallback!)
    this.player?.destroy()
    this.gameSyncManager.destroy()

    // Everything the session added; the scene's objects stay for the next session
    const scene = Game.instance().activeScene
    for (const [id, entity] of Game.instance().world.entities.items) {
      if (!scene?.entryOf(entity)) {
        entity.destroy()
        Game.instance().world.entities.items.delete(id)
      }
    }
    super.destroy()
  }
}
