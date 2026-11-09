import type { ServerEntityView } from '@mavonengine/core/Networking/Client/NetworkManager'
import type { SyncSnapshot } from '@mavonengine/core/Networking/Debug/sync'
import Game from '@mavonengine/core/Game'
import EventEmitter from '@mavonengine/core/Utils/EventEmitter'
import {
  BoxGeometry,
  BufferGeometry,
  EdgesGeometry,
  Float32BufferAttribute,
  Group,
  Line,
  LineBasicMaterial,
  LineLoop,
  LineSegments,
} from 'three'
import SyncStore from './SyncStore'

export interface NetworkOverlayOptions {
  /** A wireframe box per networked entity, where the server last said it is */
  ghosts: boolean
  /** A ring around each player at the server's sync distance */
  rings: boolean
  /** Colour the ghosts by what this player is sent, instead of by what any player is */
  viewAs: string | null
}

export type GhostState = 'synced' | 'stale' | 'untracked'

export const GHOST_COLORS: Record<GhostState, number> = {
  /** In the newest state update */
  synced: 0x4EC9B0,
  /** Known to this client, but not in the newest state update */
  stale: 0xCE9178,
  /** No player (or not the viewed one) is sent it */
  untracked: 0x888888,
}

const RING_COLOR = 0x007ACC
const RING_SELECTED_COLOR = 0xFFFFFF
const ERROR_COLOR = 0xF44747
const RING_SEGMENTS = 96
/** A ghost whose entity left the client's world is hidden once its state is this old, in ms */
const ORPHAN_GHOST_MS = 2000
/** Distance between the server's position and the rendered one from which the error line is drawn */
const ERROR_EPSILON = 0.01
const STORAGE_KEY = 'editor-network-overlay'

interface Ghost {
  box: LineSegments
  /** From the server's position to where the client renders the entity */
  error: Line
}

/**
 * How a ghost is coloured: by the server's sync when it is known, otherwise by what this client last received.
 */
export function ghostState(view: ServerEntityView, newestTick: number | null, sync?: SyncSnapshot, viewAs?: string | null): GhostState {
  if (sync) {
    const player = viewAs ? sync.players.find(p => p.id === viewAs) : undefined
    if (player)
      return player.id === view.id || player.tracked.includes(view.id) ? 'synced' : 'untracked'

    const entity = sync.entities.find(e => e.id === view.id)
    if (entity && !entity.player && entity.trackedBy === 0 && sync.players.length > 0)
      return 'untracked'
  }

  return newestTick !== null && newestTick - view.tick > 1 ? 'stale' : 'synced'
}

function loadOptions(): NetworkOverlayOptions {
  const defaults: NetworkOverlayOptions = { ghosts: false, rings: false, viewAs: null }
  try {
    return { ...defaults, ...JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}'), viewAs: null }
  }
  catch {
    return defaults
  }
}

/**
 * Draws the network state into the editor's viewport: where the server says each entity is (ghosts)
 * and how far each player's state sync reaches (rings).
 *
 * Triggers `changed` when its options change.
 */
export default class NetworkOverlay extends EventEmitter {
  readonly sync: SyncStore
  readonly group = new Group()

  private _options: NetworkOverlayOptions
  private ghosts = new Map<string, Ghost>()
  private rings = new Map<string, LineLoop>()
  private unsubscribe?: () => void

  private boxGeometry: BufferGeometry
  private ringGeometry: BufferGeometry
  private materials: Record<GhostState, LineBasicMaterial>
  private errorMaterial = overlayMaterial(ERROR_COLOR)
  private ringMaterial = overlayMaterial(RING_COLOR)
  private ringSelectedMaterial = overlayMaterial(RING_SELECTED_COLOR)

  constructor(sync = new SyncStore(), options: NetworkOverlayOptions = loadOptions()) {
    super()
    this.sync = sync
    this._options = options

    this.group.name = 'NetworkOverlay'
    this.group.userData.isEditorInternal = true

    // A unit box standing on its origin, like most entities do
    const box = new BoxGeometry(1, 1, 1)
    box.translate(0, 0.5, 0)
    this.boxGeometry = new EdgesGeometry(box)
    box.dispose()

    const circle: number[] = []
    for (let i = 0; i < RING_SEGMENTS; i++) {
      const angle = (i / RING_SEGMENTS) * Math.PI * 2
      circle.push(Math.cos(angle), 0, Math.sin(angle))
    }
    this.ringGeometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute(circle, 3))

    this.materials = {
      synced: overlayMaterial(GHOST_COLORS.synced),
      stale: overlayMaterial(GHOST_COLORS.stale),
      untracked: overlayMaterial(GHOST_COLORS.untracked),
    }

    this.applyOptions()
  }

  get options(): Readonly<NetworkOverlayOptions> {
    return this._options
  }

  setOptions(options: Partial<NetworkOverlayOptions>) {
    this._options = { ...this._options, ...options }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ ghosts: this._options.ghosts, rings: this._options.rings }))
    }
    catch {
      // Not remembered, e.g. storage is blocked
    }

    this.applyOptions()
    this.trigger('changed', this._options)
  }

  private get active() {
    return this._options.ghosts || this._options.rings
  }

  private applyOptions() {
    const scene = Game.instance().scene

    if (this.active && !this.group.parent) {
      scene.add(this.group)
      // The overlay only asks the server while something is drawn
      this.unsubscribe = this.sync.subscribe(() => { })
    }
    else if (!this.active && this.group.parent) {
      scene.remove(this.group)
      this.unsubscribe?.()
      this.unsubscribe = undefined
    }
  }

  update() {
    if (!this.active)
      return

    // A scene reload clears the scene, put the overlay back
    if (!this.group.parent)
      Game.instance().scene.add(this.group)

    this.updateGhosts()
    this.updateRings()
  }

  private updateGhosts() {
    const network = Game.instance().network
    const view = this._options.ghosts ? network?.serverView : undefined
    const { sync } = this.sync.get()
    const entities = Game.instance().world.entities.items
    const now = performance.now()
    const seen = new Set<string>()

    for (const entity of view?.entities.values() ?? []) {
      const rendered = entities.get(entity.id)
      if (!rendered && now - entity.receivedAt > ORPHAN_GHOST_MS)
        continue

      seen.add(entity.id)
      const ghost = this.ghosts.get(entity.id) ?? this.createGhost(entity.id)

      ghost.box.position.set(entity.position.x, entity.position.y, entity.position.z)
      ghost.box.rotation.set(entity.rotation.x, entity.rotation.y, entity.rotation.z)
      // 1 x 2 x 1 at scale 1, about a character: the ghost marks a transform, not the model's bounds
      ghost.box.scale.set(entity.scale.x, entity.scale.y * 2, entity.scale.z)
      ghost.box.material = this.materials[ghostState(entity, view!.tick, sync, this._options.viewAs)]

      const off = rendered ? rendered.position.distanceTo(ghost.box.position) : 0
      ghost.error.visible = off > ERROR_EPSILON
      if (ghost.error.visible) {
        const positions = ghost.error.geometry.getAttribute('position')
        positions.setXYZ(0, entity.position.x, entity.position.y, entity.position.z)
        positions.setXYZ(1, rendered!.position.x, rendered!.position.y, rendered!.position.z)
        positions.needsUpdate = true
      }
    }

    for (const [id, ghost] of this.ghosts) {
      if (seen.has(id))
        continue
      this.group.remove(ghost.box, ghost.error)
      ghost.error.geometry.dispose()
      this.ghosts.delete(id)
    }
  }

  private createGhost(id: string): Ghost {
    const box = unpickable(new LineSegments(this.boxGeometry, this.materials.synced))
    box.name = `ServerGhost:${id}`

    const geometry = new BufferGeometry().setAttribute('position', new Float32BufferAttribute([0, 0, 0, 0, 0, 0], 3))
    const error = unpickable(new Line(geometry, this.errorMaterial))
    error.frustumCulled = false
    error.visible = false

    const ghost = { box, error }
    this.group.add(box, error)
    this.ghosts.set(id, ghost)
    return ghost
  }

  private updateRings() {
    const { sync } = this.sync.get()
    const players = this._options.rings && sync?.syncDistance ? sync.players : []
    const seen = new Set<string>()

    for (const player of players) {
      seen.add(player.id)
      let ring = this.rings.get(player.id)
      if (!ring) {
        ring = unpickable(new LineLoop(this.ringGeometry, this.ringMaterial))
        ring.name = `SyncRing:${player.id}`
        this.rings.set(player.id, ring)
        this.group.add(ring)
      }

      ring.position.set(player.position.x, player.position.y + 0.05, player.position.z)
      ring.scale.setScalar(sync!.syncDistance!)
      ring.material = player.id === this._options.viewAs ? this.ringSelectedMaterial : this.ringMaterial
    }

    for (const [id, ring] of this.rings) {
      if (seen.has(id))
        continue
      this.group.remove(ring)
      this.rings.delete(id)
    }
  }

  /** How many ghosts and rings are drawn */
  get counts() {
    return { ghosts: this.ghosts.size, rings: this.rings.size }
  }

  dispose() {
    this.unsubscribe?.()
    this.unsubscribe = undefined
    this.group.removeFromParent()
    this.ghosts.forEach(ghost => ghost.error.geometry.dispose())
    this.ghosts.clear()
    this.rings.clear()
    this.boxGeometry.dispose()
    this.ringGeometry.dispose()
    Object.values(this.materials).forEach(material => material.dispose())
    this.errorMaterial.dispose()
    this.ringMaterial.dispose()
    this.ringSelectedMaterial.dispose()
  }
}

/** Drawn over the scene, so a ghost inside a mesh or behind a wall still shows */
function overlayMaterial(color: number) {
  return new LineBasicMaterial({ color, depthTest: false, depthWrite: false, transparent: true, toneMapped: false })
}

/** The overlay is never selected by a click in the viewport */
function unpickable<T extends Line>(object: T): T {
  object.raycast = () => { }
  object.renderOrder = 999
  object.userData.isEditorInternal = true
  return object
}
