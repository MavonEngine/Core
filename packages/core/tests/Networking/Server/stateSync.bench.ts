import type { ServerChannel } from '@geckos.io/server'
import { bench, describe, vi } from 'vitest'
import winston from 'winston'
import Player from '../../../src/Networking/Entities/Player'
import Server from '../../../src/Networking/Server/Server'

const mockGeckosOnConnection = vi.fn()
const mockGeckosServer = {
  onConnection: mockGeckosOnConnection,
  connectionsManager: { connections: new Map() as Map<string, any> },
  emit: vi.fn(),
}

vi.mock('@geckos.io/server', () => ({
  default: vi.fn(() => mockGeckosServer),
}))

class BenchClient extends Player {
  health = 100
  maxHealth = 100
  takeDamage(_amount: number): void {}
  heal(_amount: number): void {}
  update(_delta: number): void {}
  updateFromNetwork(_data: object): void {}
}

class BenchServer extends Server<BenchClient> {
  private syncDistance: number

  constructor(logger: winston.Logger, syncDistance: number) {
    super(logger)
    this.syncDistance = syncDistance
  }

  getStateSyncDistance(): number {
    return this.syncDistance
  }

  protected onCommand(_command: any, _delta: number): void {}

  protected onConnection(channel: ServerChannel): BenchClient {
    return new BenchClient(channel.id)
  }
}

const PLAYER_COUNT = 20

function buildScenario(syncDistance: number) {
  const logger = winston.createLogger({ transports: [], silent: true })
  const server = new BenchServer(logger, syncDistance)

  const connections = new Map<string, any>()

  for (let i = 0; i < PLAYER_COUNT; i++) {
    const id = `player-${i}`
    const emit = vi.fn()
    connections.set(id, { id, emit, channel: { emit } })

    const player = new BenchClient(id)
    // Spread players in a line so some are in range, some are not
    player.position.set(i * 5, 0, 0)
    player.needsSync = true
    server.game.world.entities.items.set(id, player)
  }

  mockGeckosServer.connectionsManager.connections = connections

  return server
}

describe('stateSync - 20 connections', () => {
  // syncDistance large enough to reach all 20 players spread 5 units apart (max dist = 95)
  const allInRange = buildScenario(200)
  bench('all players within sync distance', () => {
    ;(allInRange as any).stateSync()
  })

  // syncDistance covers only first ~10 players (spread 5 units apart, so 50 units)
  const halfInRange = buildScenario(50)
  bench('half players within sync distance', () => {
    ;(halfInRange as any).stateSync()
  })

  // syncDistance too small to reach any neighbour
  const noneInRange = buildScenario(1)
  bench('no players within sync distance', () => {
    ;(noneInRange as any).stateSync()
  })
})
