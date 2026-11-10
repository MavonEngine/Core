import type { Vec3 } from '../../Dev/inspect'
import type NetRecorder from './NetRecorder'

/**
 * Who is sent what: the server's view of its state sync, for the editor's sync overlay and the MCP tools.
 */
export interface SyncSnapshot {
  /** Number of the last server tick, the one stamped on the newest sv_state packets */
  tick: number
  /** Epoch ms */
  serverTime: number
  tickRate: number
  /** Entities closer than this to a player are sent to it. Null when the game's server doesn't tell */
  syncDistance: number | null
  players: SyncPlayer[]
  /** Channels of clients running the editor: they are sent every synced entity */
  editors: string[]
  /** Every entity the server syncs */
  entities: SyncEntity[]
}

export interface SyncStateSummary {
  tick: number
  bytes: number
  entities: number
}

export interface SyncPlayer {
  id: string
  displayName: string
  position: Vec3
  /** Sequence id of the last input of this player the server processed */
  ack: number
  /** Ids of the entities in its last state update */
  tracked: string[]
  /** The last sv_state sent to it, null when none was yet */
  lastState: SyncStateSummary | null
}

export interface SyncEntity {
  id: string
  type: string
  position: Vec3
  rotation: Vec3
  scale: Vec3
  player: boolean
  /** Changed since it was last marked synced */
  needsSync: boolean
  /** How many players had it in their last state update. 0: no player is in range of it */
  trackedBy: number
  /** Tick it was last sent to a player or an editor in, null when it never was */
  lastSentTick: number | null
}

/** What the HTTP server needs to serve the network debug endpoints under GET /api/game/dev/net */
export interface NetDebugSource {
  readonly net: NetRecorder
  syncSnapshot(): SyncSnapshot
}
