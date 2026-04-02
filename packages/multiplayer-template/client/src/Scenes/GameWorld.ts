import Game from '@mavonengine/core/Game'
import GameObject from '@mavonengine/core/World/GameObject'
import {
  AmbientLight,
  Color,
  DirectionalLight,
  FogExp2,
  GridHelper,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  Vector3,
} from 'three'
import Character from '../Entities/Player'
import GameSyncManager from '../GameSyncManager'
import NetworkManager from '../NetworkManager'
import PlayerController from '../PlayerController'

export default class GameWorld extends GameObject {
  player: Character
  playerController: PlayerController
  gameSyncManager: GameSyncManager
  private updateCallback?: (delta: number) => void

  constructor() {
    super()

    this.setupLighting()
    this.setupGround()

    // Local player box (green)
    this.player = new Character('localPlayer', true, new Vector3(0, 0.5, 0))
    this.playerController = new PlayerController(this.player)
    this.gameSyncManager = new GameSyncManager(new NetworkManager(), this.playerController)

    Game.instance().world.add({ PlayerController: this.playerController })

    this.updateCallback = delta => this.update(delta)
    Game.instance().onUpdate(this.updateCallback)
  }

  private setupLighting() {
    const skyColor = new Color(0x87CEEB)
    Game.instance().scene.background = skyColor
    Game.instance().scene.fog = new FogExp2(skyColor, 0.012)

    const ambient = new AmbientLight(0xFFFFFF, 0.6)
    Game.instance().scene.add(ambient)

    const sun = new DirectionalLight(0xFFF4E0, 1.2)
    sun.position.set(20, 40, 20)
    sun.castShadow = true
    sun.shadow.mapSize.set(2048, 2048)
    sun.shadow.camera.near = 0.5
    sun.shadow.camera.far = 200
    sun.shadow.camera.left = -50
    sun.shadow.camera.right = 50
    sun.shadow.camera.top = 50
    sun.shadow.camera.bottom = -50
    Game.instance().scene.add(sun)
  }

  private setupGround() {
    // Large flat plane
    const geo = new PlaneGeometry(200, 200)
    const mat = new MeshStandardMaterial({ color: 0x4A7C59 })
    const plane = new Mesh(geo, mat)
    plane.rotation.x = -Math.PI / 2
    plane.receiveShadow = true
    Game.instance().scene.add(plane)

    // Grid overlay for spatial reference
    const grid = new GridHelper(200, 40, 0x000000, 0x000000)
    ;(grid.material as { opacity: number, transparent: boolean }).opacity = 0.08
    ;(grid.material as { opacity: number, transparent: boolean }).transparent = true
    Game.instance().scene.add(grid)
  }

  update(delta: number): void {
    // PlayerController is in world.entities so its update() (and player.update()) is
    // already called by the engine world loop. We only need to tick the sync manager.
    this.gameSyncManager.update(delta)
  }

  destroy(): void {
    Game.instance().unregisterOnUpdate(this.updateCallback!)
    Game.instance().scene.background = null
    Game.instance().scene.fog = null
    this.player.destroy()
    this.gameSyncManager.destroy()
    Game.instance().world.destroy()
    super.destroy()
  }
}
