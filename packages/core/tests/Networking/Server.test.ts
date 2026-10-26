import type { ServerChannel } from '@geckos.io/server'
import type ServerWorld from '../../src/Networking/Server/World'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import winston from 'winston'
import Player from '../../src/Networking/Entities/Player'
import { ServerCommand } from '../../src/Networking/Server/Commands'
import Server from '../../src/Networking/Server/Server'

const mockGeckosOnConnection = vi.fn()

const mockGeckosServer = {
  onConnection: mockGeckosOnConnection,
  connectionsManager: { connections: new Map() as Map<string, any> },
  emit: vi.fn(),
}

vi.mock('@geckos.io/server', () => {
  return {
    default: vi.fn(() => mockGeckosServer),
  }
})

class TestClient extends Player {
  health = 100
  maxHealth = 100

  takeDamage(_amount: number): void { }

  heal(_amount: number): void { }

  update(_delta: number): void { }

  updateFromNetwork(_data: object): void {
    throw new Error('Method not implemented.')
  }
}

class TestServer extends Server<TestClient> {
  getStateSyncDistance(): number {
    throw new Error('Method not implemented.')
  }

  protected onCommand(_command: any, _delta: number): void {
    // throw new Error('Method not implemented.')
  }

  protected onConnection(channel: ServerChannel): TestClient {
    return new TestClient(channel.id)
  }
}

describe('server', () => {
  let logger: winston.Logger

  beforeEach(() => {
    vi.clearAllMocks()
    logger = winston.createLogger({ transports: [], silent: true })
  })

  it('should call onConnected and add client to player list / remove client when disconnecting', () => {
    const server = new TestServer(logger)
    expect((server.game.world as ServerWorld).players).toHaveLength(0)
    expect(mockGeckosOnConnection).toBeCalled()

    const randomId = Math.random().toString()

    //  fake disconnect function that we can trigger manually
    let disconnectCallback: () => void = () => { }

    // Call server.gameSocket.onConnection()
    mockGeckosOnConnection.mock.calls[0][0]({
      id: randomId,
      on: vi.fn(),
      onDisconnect: (cb: () => void) => {
        disconnectCallback = cb
      },
    })

    expect((server.game.world as ServerWorld).players).toHaveLength(1)
    expect((server.game.world as ServerWorld).players[0].id).eq(randomId)

    // Simulate a disconnect from the client
    disconnectCallback()

    // Assert the client was marked for removal
    expect((server.game.world as ServerWorld).players[0].garbageCollect).toBe(true)

    // Emulate tick
    server.game.update(0.1)

    expect((server.game.world as ServerWorld).players).toHaveLength(0)
    expect(server.game.world.entities.items.has(randomId)).toBe(false)
  })

  it('should respond with pong', () => {
    const _server = new TestServer(logger)
    expect(mockGeckosOnConnection).toBeCalled()

    const emit = vi.fn()
    const eventCallbacks: Record<string, (...args: any[]) => void> = {}

    mockGeckosOnConnection.mock.calls[0][0]({
      id: 'test-id',
      on: (event: string, cb: () => void) => {
        eventCallbacks[event] = cb
      },
      emit,
      onDisconnect: vi.fn(),
    })

    // Simulate client sending 'ping'
    eventCallbacks.ping()

    expect(emit).toHaveBeenCalledWith('pong')
  })

  it('should call bufferIncomingCommand', () => {
    const server = new TestServer(logger)
    const onCallback: Record<string, (...args: any[]) => void> = {}
    expect((server as any).commandBuffer).toHaveLength(0)

    mockGeckosOnConnection.mock.calls[0][0]({
      id: 'test-id',
      on: (event: string, cb: () => void) => {
        onCallback[event] = cb
      },
      onDisconnect: vi.fn(),
    })

    const testCommand = {
      command: 'test_command',
    }
    onCallback.command(testCommand)
    expect((server as any).commandBuffer).toHaveLength(1)
    expect((server as any).commandBuffer).toContainEqual({
      playerId: 'test-id',
      ...testCommand,
    })
  })

  it('should call onCommand', () => {
    const server = new TestServer(logger)

    const player = new TestClient('p1')
    server.game.world.entities.items.set('p1', player)

    const onCommand = vi.fn()
    const testCommand = { command: 'test-command', playerId: 'p1', sequenceId: 0 }
    const randomDelta = Math.random();

    (server as any).onCommand = onCommand;
    (server as any).calculateDelta = () => {
      return randomDelta
    }
    (server as any).commandBuffer = [testCommand];
    (server as any).runThroughBuffer()

    expect(onCommand).toBeCalledWith(testCommand, randomDelta)
  })

  it('sorts the commandBuffer by sequenceId before processing', () => {
    const server = new TestServer(logger)

    const player = new TestClient('p1')
    server.game.world.entities.items.set('p1', player)

    const processed: number[] = []
    ;(server as any).onCommand = (cmd: { sequenceId: number }) => {
      processed.push(cmd.sequenceId)
    }
    ;(server as any).commandBuffer = [
      { sequenceId: 3, playerId: 'p1' },
      { sequenceId: 1, playerId: 'p1' },
      { sequenceId: 4, playerId: 'p1' },
      { sequenceId: 2, playerId: 'p1' },
    ]

    ;(server as any).runThroughBuffer()

    expect(processed).toEqual([1, 2, 3, 4])
    expect(player.lastProcessedSequenceId).toBe(4)
  })

  it('skips commands from players that disconnected before they were processed', () => {
    const server = new TestServer(logger)

    const onCommand = vi.fn()
    ;(server as any).onCommand = onCommand
    ;(server as any).commandBuffer = [{ sequenceId: 1, playerId: 'gone' }]

    expect(() => (server as any).runThroughBuffer()).not.toThrow()
    expect(onCommand).not.toHaveBeenCalled()
  })

  it('never moves lastProcessedSequenceId backwards', () => {
    const server = new TestServer(logger)

    const player = new TestClient('p1')
    player.updateLastProcessedSequenceId(10)
    server.game.world.entities.items.set('p1', player)

    ;(server as any).commandBuffer = [{ sequenceId: 4, playerId: 'p1' }]
    ;(server as any).runThroughBuffer()

    expect(player.lastProcessedSequenceId).toBe(10)
  })

  it('passes the same delta to every command in a tick and resets it afterwards', () => {
    const server = new TestServer(logger)
    server.game.world.entities.items.set('p1', new TestClient('p1'))

    const deltas: number[] = []
    ;(server as any).onCommand = (_cmd: unknown, delta: number) => deltas.push(delta)

    server.lastTime = performance.now() - 1000
    ;(server as any).commandBuffer = [
      { sequenceId: 1, playerId: 'p1' },
      { sequenceId: 2, playerId: 'p1' },
    ]

    expect((server as any).runThroughBuffer()).toBe(2)
    expect(deltas[0]).toBeGreaterThanOrEqual(1000)
    expect(deltas[1]).toBe(deltas[0])
    expect((server as any).calculateDelta()).toBeLessThan(1000)
  })

  it('records tick duration and processed commands when a tick completes', () => {
    const server = new TestServer(logger)
    server.game.world.entities.items.set('p1', new TestClient('p1'))
    server.getStateSyncDistance = () => 100

    ;(server as any).commandBuffer = [{ sequenceId: 1, playerId: 'p1' }]
    server.game.tick()

    expect(server.metrics.tick.sample()).toMatchObject({ ticks: 1, maxCommandsPerTick: 1 })
  })

  it('exposes the latency simulation config to metrics', () => {
    const server = new TestServer(logger, undefined, { latencySimulation: { fixedLatency: 20 } })

    expect(server.metrics.snapshot().latencySimulation).toEqual({ fixedLatency: 20, jitter: 0, packetLoss: 0 })
  })

  it('listens on the configured ports', () => {
    const server = new TestServer(logger, undefined, { socketPort: 9001, httpPort: 9002 })

    const listen = vi.fn()
    ;(server.gameSocket as any).listen = listen
    const httpStart = vi.spyOn(server.http, 'start').mockImplementation(() => {})

    server.start()
    server.stop()

    expect(listen).toHaveBeenCalledWith(9001)
    expect(httpStart).toHaveBeenCalled()
    expect((server.http as any).port).toBe(9002)
  })

  describe('stateSync', () => {
    function makeConnection(id: string) {
      const emit = vi.fn()
      return {
        id,
        emit,
        channel: { emit },
      }
    }

    function addPlayer(server: TestServer, id: string, x = 0) {
      const player = new TestClient(id)
      player.position.set(x, 0, 0)
      server.game.world.entities.items.set(id, player)
      return player
    }

    it('emits SV_STATE to each connected player', () => {
      const server = new TestServer(logger)
      server.getStateSyncDistance = () => 100

      const conn1 = makeConnection('p1')
      const conn2 = makeConnection('p2')
      mockGeckosServer.connectionsManager.connections = new Map([
        ['p1', conn1],
        ['p2', conn2],
      ])

      const _p1 = addPlayer(server, 'p1', 0)
      const _p2 = addPlayer(server, 'p2', 5)

      ;(server as any).stateSync()

      expect(conn1.channel.emit).toHaveBeenCalledWith(
        ServerCommand.SV_STATE,
        expect.objectContaining({ type: ServerCommand.SV_STATE }),
      )
      expect(conn2.channel.emit).toHaveBeenCalledWith(
        ServerCommand.SV_STATE,
        expect.objectContaining({ type: ServerCommand.SV_STATE }),
      )
    })

    it('only includes entities within the sync distance', () => {
      const server = new TestServer(logger)
      server.getStateSyncDistance = () => 10

      const conn = makeConnection('p1')
      mockGeckosServer.connectionsManager.connections = new Map([['p1', conn]])

      const p1 = addPlayer(server, 'p1', 0)
      const nearby = addPlayer(server, 'nearby', 5)
      const farAway = addPlayer(server, 'faraway', 50)

      ;(server as any).stateSync()

      const emittedState = conn.channel.emit.mock.calls[0][1]
      const ids = emittedState.entities.map((e: any) => e.id)
      expect(ids).toContain(p1.id)
      expect(ids).toContain(nearby.id)
      expect(ids).not.toContain(farAway.id)
    })

    it('calls markSyncd on entities that needed sync', () => {
      const server = new TestServer(logger)
      server.getStateSyncDistance = () => 100

      const conn = makeConnection('p1')
      mockGeckosServer.connectionsManager.connections = new Map([['p1', conn]])

      const p1 = addPlayer(server, 'p1', 0)
      p1.needsSync = true

      const markSyncd = vi.spyOn(p1, 'markSyncd')

      ;(server as any).stateSync()

      expect(markSyncd).toHaveBeenCalled()
    })

    it('does not call markSyncd on entities that do not need sync and are already tracked', () => {
      const server = new TestServer(logger)
      server.getStateSyncDistance = () => 100

      const conn = makeConnection('p1')
      mockGeckosServer.connectionsManager.connections = new Map([['p1', conn]])

      const p1 = addPlayer(server, 'p1', 0)
      p1.needsSync = false
      p1.trackedEntities.add(p1.id)

      const markSyncd = vi.spyOn(p1, 'markSyncd')

      ;(server as any).stateSync()

      expect(markSyncd).not.toHaveBeenCalled()
    })

    it('removes out-of-range entities from player trackedEntities', () => {
      const server = new TestServer(logger)
      server.getStateSyncDistance = () => 10

      const conn = makeConnection('p1')
      mockGeckosServer.connectionsManager.connections = new Map([['p1', conn]])

      const p1 = addPlayer(server, 'p1', 0)
      const farAway = addPlayer(server, 'faraway', 50)
      p1.trackedEntities.add(farAway.id)

      ;(server as any).stateSync()

      expect(p1.trackedEntities.has(farAway.id)).toBe(false)
    })

    it('skips a player connection that has no matching entity', () => {
      const server = new TestServer(logger)
      server.getStateSyncDistance = () => 100

      const conn = makeConnection('ghost')
      mockGeckosServer.connectionsManager.connections = new Map([['ghost', conn]])

      // no entity added for 'ghost'

      ;(server as any).stateSync()

      expect(conn.channel.emit).not.toHaveBeenCalled()
    })
  })
})
