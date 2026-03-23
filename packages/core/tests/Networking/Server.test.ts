import type { ServerChannel } from '@geckos.io/server'
import type ServerWorld from '../../src/Networking/Server/World'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import winston from 'winston'
import Player from '../../src/Networking/Entities/Player'
import Server from '../../src/Networking/Server/Server'

const mockGeckosOnConnection = vi.fn()

const mockGeckosServer = {
  onConnection: mockGeckosOnConnection,
  connectionsManager: { connections: [] },
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

    const onCommand = vi.fn()
    const testCommand = { command: 'test-command' }
    const randomDelta = Math.random();

    (server as any).onCommand = onCommand;
    (server as any).calculateDelta = () => {
      return randomDelta
    }
    (server as any).commandBuffer = [testCommand];
    (server as any).runThroughBuffer()

    expect(onCommand).toBeCalledWith(testCommand, randomDelta)
  })
})
