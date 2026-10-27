import { describe, expect, it, vi } from 'vitest'
import BaseGame from '../../../../src/BaseGame'
import Player from '../../../../src/Networking/Entities/Player'
import ServerMetrics, { METRICS_SCHEMA_VERSION, SERVER_BANDWIDTH_ID } from '../../../../src/Networking/Server/Stats/ServerMetrics'
import ServerWorld from '../../../../src/Networking/Server/World'

class TestPlayer extends Player {
  health = 100
  maxHealth = 100
  takeDamage(_amount: number): void { }
  heal(_amount: number): void { }
  update(_delta: number): void { }
}

function makeMetrics(latencySimulation?: any) {
  const logger = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } as any
  const game = new BaseGame(null)
  game.world = new ServerWorld()

  const metrics = new ServerMetrics({ game, latencySimulation }, logger, { sampleIntervalMs: 500 })

  return { game, metrics }
}

function addPlayer(game: BaseGame, id: string) {
  const player = new TestPlayer(id)
  game.world.entities.items.set(id, player)
  return player
}

describe('serverMetrics', () => {
  it('builds a snapshot of the server', () => {
    const { game, metrics } = makeMetrics({ fixedLatency: 50, jitter: 10, packetLoss: 0 })

    const player = addPlayer(game, 'p1')
    player.position.set(1, 2, 3)
    player.updateLastProcessedSequenceId(7)
    player.trackedEntities.add('p1')
    player.setDisplayName('Alice')

    const snapshot = metrics.snapshot()

    expect(snapshot.schemaVersion).toBe(METRICS_SCHEMA_VERSION)
    expect(snapshot.sampleIntervalMs).toBe(500)
    expect(snapshot.tickRate).toBe(game.tickRate)
    expect(snapshot.players).toEqual([{
      id: 'p1',
      displayName: 'Alice',
      position: { x: 1, y: 2, z: 3 },
      lastProcessedSequenceId: 7,
      trackedEntities: 1,
      connectedFor: 0,
      connection: null,
    }])
    expect(snapshot.world.entities).toBe(1)
    expect(snapshot.physics).toBeNull()
    expect(snapshot.latencySimulation).toEqual({ fixedLatency: 50, jitter: 10, packetLoss: 0 })
    expect(snapshot.memory.rss).toBeGreaterThan(0)
  })

  it('includes how long players have been connected and their connection details', () => {
    const { game, metrics } = makeMetrics()

    const p1 = addPlayer(game, 'p1')
    p1.connectedAt = Date.now() - 90_000
    p1.channel = { webrtcConnection: { peerConnection: {
      rtt: () => 42,
      bytesSent: () => 1000,
      bytesReceived: () => 200,
      getSelectedCandidatePair: () => ({ remote: { address: '203.0.113.7' } }),
    } } } as any
    addPlayer(game, 'bot')

    const [connected, bot] = metrics.snapshot().players
    expect(connected.connectedFor).toBe(90)
    expect(connected.connection).toEqual({ address: '203.0.113.7', rttMs: 42, bytesSent: 1000, bytesReceived: 200 })
    expect(bot.connection).toBeNull()
  })

  it('uses the player id as the display name until one is set', () => {
    const { game, metrics } = makeMetrics()

    const player = addPlayer(game, 'p1')
    expect(metrics.snapshot().players[0].displayName).toBe('p1')

    player.setDisplayName('Alice')
    expect(metrics.snapshot().players[0].displayName).toBe('Alice')

    player.setDisplayName(null)
    expect(metrics.snapshot().players[0].displayName).toBe('p1')
  })

  it('leaves out players that are marked for removal', () => {
    const { game, metrics } = makeMetrics()

    addPlayer(game, 'p1')
    addPlayer(game, 'p2').destroy()

    expect(metrics.snapshot().players.map(p => p.id)).toEqual(['p1'])
    expect(metrics.health().players).toBe(1)
  })

  it('reports bandwidth per second from the latest sample', () => {
    const { metrics } = makeMetrics()

    metrics.bandwidth.recordSent(SERVER_BANDWIDTH_ID, 100)
    metrics.bandwidth.recordReceived(SERVER_BANDWIDTH_ID, 40)
    metrics.sample()

    const { bandwidth } = metrics.snapshot()

    // sampled every 500ms so per second is double
    expect(bandwidth.sentPerSecond).toBe(200)
    expect(bandwidth.receivedPerSecond).toBe(80)
    expect(bandwidth.history).toHaveLength(1)
  })

  it('samples every tracker', () => {
    const { metrics } = makeMetrics()

    metrics.tick.record(5, 2)
    metrics.sample()

    const snapshot = metrics.snapshot()

    expect(snapshot.cpu.history).toHaveLength(1)
    expect(snapshot.tick.latest).toMatchObject({ ticks: 1, avgMs: 5, maxCommandsPerTick: 2 })
    expect(snapshot.tick.budgetMs).toBeCloseTo(1000 / 30, 1)
  })

  it('serializes to JSON without losing data', () => {
    const { metrics } = makeMetrics()
    metrics.sample()

    const snapshot = metrics.snapshot()

    expect(JSON.parse(JSON.stringify(snapshot))).toEqual(snapshot)
  })
})
