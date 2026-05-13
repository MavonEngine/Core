import { beforeEach, describe, expect, it, vi } from 'vitest'
import NetworkManager from '../../../src/Networking/Client/NetworkManager'

const mockSocket = {
  onConnect: vi.fn(),
  onDisconnect: vi.fn(),
  on: vi.fn(),
  emit: vi.fn(),
  close: vi.fn(),
  id: 'test-socket-id',
}

vi.mock('@geckos.io/client', () => ({
  geckos: vi.fn(() => mockSocket),
}))

const mockLogger = {
  error: vi.fn(),
  info: vi.fn(),
}

const mockGame = {
  on: vi.fn(),
  logger: mockLogger,
}

vi.mock('../../../src/BaseGame', () => ({
  default: {
    instance: vi.fn(() => mockGame),
  },
}))

describe('networkManager', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('creates a socket and registers connect/disconnect callbacks', () => {
    const _nm = new NetworkManager({})
    expect(mockSocket.onConnect).toHaveBeenCalled()
    expect(mockSocket.onDisconnect).toHaveBeenCalled()
  })

  it('registers editorBoot handler on the game instance', () => {
    const _nm = new NetworkManager({})
    expect(mockGame.on).toHaveBeenCalledWith('editorBoot', expect.any(Function))
  })

  it('sets connected=true and logs on successful connect', () => {
    const nm = new NetworkManager({})
    const connectCb = mockSocket.onConnect.mock.calls[0][0]
    connectCb(undefined)
    expect(nm.connected).toBe(true)
    expect(mockLogger.info).toHaveBeenCalledWith(expect.stringContaining('test-socket-id'))
  })

  it('logs error and stays disconnected on socket connection error', () => {
    const nm = new NetworkManager({})
    const connectCb = mockSocket.onConnect.mock.calls[0][0]
    connectCb(new Error('Connection refused'))
    expect(nm.connected).toBe(false)
    expect(mockLogger.error).toHaveBeenCalledWith(expect.stringContaining('Connection refused'))
  })

  it('sets connected=false on socket disconnect', () => {
    const nm = new NetworkManager({})
    mockSocket.onConnect.mock.calls[0][0](undefined)
    expect(nm.connected).toBe(true)
    mockSocket.onDisconnect.mock.calls[0][0]()
    expect(nm.connected).toBe(false)
  })

  it('closes socket when editorBoot event fires', () => {
    const _nm = new NetworkManager({})
    const [event, handler] = mockGame.on.mock.calls[0]
    expect(event).toBe('editorBoot')
    handler()
    expect(mockSocket.close).toHaveBeenCalled()
  })

  it('destroy() closes the socket when connected', () => {
    const nm = new NetworkManager({})
    mockSocket.onConnect.mock.calls[0][0](undefined)
    nm.destroy()
    expect(mockSocket.close).toHaveBeenCalled()
    expect(nm.connected).toBe(false)
  })

  it('destroy() does not close socket when not connected', () => {
    const nm = new NetworkManager({})
    nm.destroy()
    expect(mockSocket.close).not.toHaveBeenCalled()
  })

  it('destroy() clears the singleton instance', () => {
    const nm = new NetworkManager({})
    expect(NetworkManager.getInstance()).toBe(nm)
    nm.destroy()
    expect(NetworkManager.getInstance()).toBeUndefined()
  })

  it('exposes socket via socket getter', () => {
    const nm = new NetworkManager({})
    expect(nm.socket).toBe(mockSocket)
  })

  it('registers pong handler after connecting and updates ping', () => {
    const nm = new NetworkManager({})
    mockSocket.onConnect.mock.calls[0][0](undefined)

    const pongCall = mockSocket.on.mock.calls.find(([event]) => event === 'pong')
    expect(pongCall).toBeDefined()

    ;(nm as any).pingNow = performance.now() - 100
    pongCall![1]()
    expect(nm.ping).toBeGreaterThan(0)
  })

  it('emits ping on socket after connect interval fires', () => {
    vi.useFakeTimers()
    const _nm = new NetworkManager({})
    mockSocket.onConnect.mock.calls[0][0](undefined)

    vi.advanceTimersByTime(1000)
    expect(mockSocket.emit).toHaveBeenCalledWith('ping')
    vi.useRealTimers()
  })

  describe('command queue', () => {
    it('sendCommand assigns sequential sequenceIds starting at 0', () => {
      const nm = new NetworkManager({})
      const a = { type: 'cmd_a' as any }
      const b = { type: 'cmd_b' as any }
      const c = { type: 'cmd_c' as any }

      nm.sendCommand(a)
      nm.sendCommand(b)
      nm.sendCommand(c)

      expect(a.sequenceId).toBe(0)
      expect(b.sequenceId).toBe(1)
      expect(c.sequenceId).toBe(2)
    })

    it('sendCommand pushes the packet to the local queue and emits it on the socket', () => {
      const nm = new NetworkManager({})
      const packet = { type: 'cmd' as any }

      nm.sendCommand(packet)

      const queue = (nm as any).localCommandQueue
      expect(queue).toHaveLength(1)
      expect(queue[0]).toBe(packet)
      expect(mockSocket.emit).toHaveBeenCalledWith('command', packet)
    })

    it('dropCommandsAtSequenceId removes acknowledged commands with sequenceId <= given', () => {
      const nm = new NetworkManager({})
      nm.sendCommand({ type: 'a' as any })
      nm.sendCommand({ type: 'b' as any })
      nm.sendCommand({ type: 'c' as any })
      nm.sendCommand({ type: 'd' as any })

      nm.dropCommandsAtSequenceId(2)

      const queue = (nm as any).localCommandQueue as { type: string, sequenceId: number }[]
      expect(queue.map(p => p.sequenceId)).toEqual([3])
    })

    it('dropCommandsAtSequenceId keeps commands with sequenceId greater than given', () => {
      const nm = new NetworkManager({})
      nm.sendCommand({ type: 'a' as any })
      nm.sendCommand({ type: 'b' as any })
      nm.sendCommand({ type: 'c' as any })

      nm.dropCommandsAtSequenceId(0)

      const queue = (nm as any).localCommandQueue as { sequenceId: number }[]
      expect(queue.map(p => p.sequenceId)).toEqual([1, 2])
    })

    it('dropCommandsAtSequenceId clears the queue when the ack covers every command', () => {
      const nm = new NetworkManager({})
      nm.sendCommand({ type: 'a' as any })
      nm.sendCommand({ type: 'b' as any })
      nm.sendCommand({ type: 'c' as any })

      nm.dropCommandsAtSequenceId(10)

      const queue = (nm as any).localCommandQueue as unknown[]
      expect(queue).toHaveLength(0)
    })

    it('dropCommandsAtSequenceId is a no-op on an empty queue', () => {
      const nm = new NetworkManager({})

      expect(() => nm.dropCommandsAtSequenceId(5)).not.toThrow()
      expect((nm as any).localCommandQueue).toHaveLength(0)
    })
  })
})
