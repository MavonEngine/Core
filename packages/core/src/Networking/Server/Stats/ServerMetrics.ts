import type winston from 'winston'
import type BaseGame from '../../../BaseGame'
import type { LatencySimulatorOptions } from '../LatencySimulator'
import type ServerWorld from '../World'
import type { BandwidthSample } from './BandwidthTracker'
import type { CpuHistoryEntry } from './CpuTracker'
import type { TickSample } from './TickTracker'
import process from 'node:process'
import { version as ENGINE_VERSION } from '../../../version'
import BandwidthTracker from './BandwidthTracker'
import CpuTracker from './CpuTracker'
import TickTracker from './TickTracker'

/**
 * Bumped whenever a field is removed or changes meaning.
 * Consumers (e.g. the mavonengine CLI dashboard) should tolerate unknown fields.
 */
export const METRICS_SCHEMA_VERSION = 1

export interface PlayerMetrics {
  id: string
  position: { x: number, y: number, z: number }
  lastProcessedSequenceId: number
  trackedEntities: number
}

export interface ServerHealth {
  serverTime: string
  uptime: number
  players: number
  world: {
    entities: number
  }
  physics: {
    bodies?: number
    colliders?: number
  }
}

export interface ServerMetricsSnapshot {
  schemaVersion: typeof METRICS_SCHEMA_VERSION
  engineVersion: string
  serverTime: string
  /** Seconds since the process started */
  uptime: number
  /** Ms between metric samples, i.e. the width of each history bucket */
  sampleIntervalMs: number
  tickRate: number
  players: PlayerMetrics[]
  world: {
    entities: number
  }
  physics: {
    bodies: number
    colliders: number
  } | null
  cpu: {
    current: number
    avg1s: number
    avg10s: number
    avg60s: number
    history: CpuHistoryEntry[]
  }
  bandwidth: {
    sentPerSecond: number
    receivedPerSecond: number
    history: BandwidthSample[]
  }
  tick: {
    budgetMs: number
    latest: TickSample | null
    history: TickSample[]
  }
  memory: {
    rss: number
    heapUsed: number
    heapTotal: number
    external: number
  }
  latencySimulation: Required<LatencySimulatorOptions> | null
}

export interface ServerMetricsOptions {
  /** How often trackers are sampled, in ms. Default 1000 */
  sampleIntervalMs?: number
  /** How many samples each tracker keeps. Default 60 */
  historyLength?: number
}

export interface ServerMetricsSource {
  game: BaseGame
  latencySimulation?: Readonly<Required<LatencySimulatorOptions>>
}

/**
 * Bandwidth is tracked under a single id for the whole server.
 */
export const SERVER_BANDWIDTH_ID = 'server'

/**
 * Collects server statistics on a fixed interval and builds snapshots of them.
 */
export default class ServerMetrics {
  readonly cpu: CpuTracker
  readonly bandwidth: BandwidthTracker
  readonly tick: TickTracker

  readonly sampleIntervalMs: number

  constructor(
    private source: ServerMetricsSource,
    logger: winston.Logger,
    { sampleIntervalMs = 1000, historyLength = 60 }: ServerMetricsOptions = {},
  ) {
    this.sampleIntervalMs = sampleIntervalMs
    this.cpu = new CpuTracker(logger)
    this.bandwidth = new BandwidthTracker(historyLength)
    this.tick = new TickTracker(historyLength)
  }

  /**
   * Close the current sampling window on every tracker.
   */
  sample(now = Date.now()) {
    this.cpu.sample()
    this.bandwidth.sample(SERVER_BANDWIDTH_ID, now)
    this.tick.sample(now)
  }

  health(): ServerHealth {
    const { game } = this.source

    return {
      serverTime: new Date().toISOString(),
      uptime: Math.round(performance.now() / 1000),
      players: this.players().length,
      world: {
        entities: game.world.entities.length,
      },
      physics: {
        bodies: game.physicsWorld?.bodies.len(),
        colliders: game.physicsWorld?.colliders.len(),
      },
    }
  }

  snapshot(): ServerMetricsSnapshot {
    const { game, latencySimulation } = this.source
    const cpu = this.cpu.latest
    const lastBandwidth = this.bandwidth.history.at(-1)
    const perSecond = 1000 / this.sampleIntervalMs
    const memory = process.memoryUsage()

    return {
      schemaVersion: METRICS_SCHEMA_VERSION,
      engineVersion: ENGINE_VERSION,
      serverTime: new Date().toISOString(),
      uptime: Math.round(performance.now() / 1000),
      sampleIntervalMs: this.sampleIntervalMs,
      tickRate: game.tickRate,
      players: this.players().map(player => ({
        id: player.id,
        position: { x: player.position.x, y: player.position.y, z: player.position.z },
        lastProcessedSequenceId: player.lastProcessedSequenceId,
        trackedEntities: player.trackedEntities.size,
      })),
      world: {
        entities: game.world.entities.length,
      },
      physics: game.physicsWorld
        ? {
            bodies: game.physicsWorld.bodies.len(),
            colliders: game.physicsWorld.colliders.len(),
          }
        : null,
      cpu: {
        current: cpu?.cpuPercentage ?? 0,
        avg1s: cpu?.avg1s ?? 0,
        avg10s: cpu?.avg10s ?? 0,
        avg60s: cpu?.avg60s ?? 0,
        history: [...this.cpu.history],
      },
      bandwidth: {
        sentPerSecond: Math.round((lastBandwidth?.sent ?? 0) * perSecond),
        receivedPerSecond: Math.round((lastBandwidth?.received ?? 0) * perSecond),
        history: [...this.bandwidth.history],
      },
      tick: {
        budgetMs: Math.round((1000 / game.tickRate) * 100) / 100,
        latest: this.tick.latest ?? null,
        history: [...this.tick.history],
      },
      memory: {
        rss: memory.rss,
        heapUsed: memory.heapUsed,
        heapTotal: memory.heapTotal,
        external: memory.external,
      },
      latencySimulation: latencySimulation ? { ...latencySimulation } : null,
    }
  }

  /**
   * Players that haven't been marked for removal yet.
   */
  private players() {
    return (this.source.game.world as ServerWorld).players.filter(player => !player.garbageCollect)
  }
}
