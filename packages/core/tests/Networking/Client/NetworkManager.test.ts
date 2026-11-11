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

  it('keeps the socket open when the editor boots and tells the server it is an editor', () => {
    const nm = new NetworkManager({})
    mockSocket.onConnect.mock.calls[0][0](undefined)
    const [event, handler] = mockGame.on.mock.calls[0]
    expect(event).toBe('editorBoot')
    handler()
    expect(mockSocket.close).not.toHaveBeenCalled()
    expect(mockSocket.emit).toHaveBeenCalledWith('cl_editor', { type: 'cl_editor' }, { reliable: true })
    expect(nm.editorMode).toBe(true)
  })

  it('announces the editor once it connects when the editor booted first', () => {
    const _nm = new NetworkManager({})
    mockGame.on.mock.calls[0][1]()
    expect(mockSocket.emit).not.toHaveBeenCalledWith('cl_editor', expect.anything(), expect.anything())
    mockSocket.onConnect.mock.calls[0][0](undefined)
    expect(mockSocket.emit).toHaveBeenCalledWith('cl_editor', { type: 'cl_editor' }, { reliable: true })
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

  describe('server view', () => {
    const stateHandler = () => mockSocket.on.mock.calls.find(([event]) => event === 'sv_state')![1]
    const entity = (id: string, x: number) => ({ id, $typeName: 'rock', position: { x, y: 0, z: 0 }, rotation: { x: 0, y: 1, z: 0 }, scale: { x: 1, y: 1, z: 1 } })

    it('keeps the tick, server time and ack of the last state', () => {
      const nm = new NetworkManager({})
      expect(nm.serverView).toMatchObject({ tick: null, ack: null, receivedAt: null, missedStates: 0 })

      stateHandler()({ tick: 5, serverTime: 1234, ack: 9, entities: [entity('rock', 1)] })

      expect(nm.serverView).toMatchObject({ tick: 5, serverTime: 1234, ack: 9, missedStates: 0 })
      expect(nm.serverView.receivedAt).toBeGreaterThan(0)
      // Entities are only kept for the dev tools
      expect(nm.serverView.entities.size).toBe(0)
    })

    it('keeps the raw state of each entity while recording, until the server removes it', () => {
      const nm = new NetworkManager({})
      nm.net.enabled = true

      stateHandler()({ tick: 5, serverTime: 1, ack: 0, entities: [entity('rock', 1), entity('tree', 2)] })
      stateHandler()({ tick: 6, serverTime: 2, ack: 0, entities: [entity('rock', 3)] })

      expect(nm.serverView.entities.get('rock')).toMatchObject({ id: 'rock', type: 'rock', position: { x: 3, y: 0, z: 0 }, rotation: { x: 0, y: 1, z: 0 }, tick: 6 })
      // Not in the newest state: still where the server last said, with the tick it said so in
      expect(nm.serverView.entities.get('tree')).toMatchObject({ position: { x: 2, y: 0, z: 0 }, tick: 5 })

      mockSocket.on.mock.calls.find(([event]) => event === 'sv_remove_entity')![1]({ id: 'tree' })
      expect(nm.serverView.entities.has('tree')).toBe(false)
    })

    it('counts states that never arrived and ignores ones that arrive late', () => {
      const nm = new NetworkManager({})
      nm.net.enabled = true

      stateHandler()({ tick: 5, serverTime: 1, ack: 0, entities: [entity('rock', 5)] })
      stateHandler()({ tick: 8, serverTime: 2, ack: 0, entities: [entity('rock', 8)] })
      stateHandler()({ tick: 7, serverTime: 2, ack: 0, entities: [entity('rock', 7)] })

      expect(nm.serverView).toMatchObject({ tick: 8, missedStates: 2 })
      expect(nm.serverView.entities.get('rock')!.position.x).toBe(8)
      expect(nm.net.list({ kind: 'event' }).records).toMatchObject([
        { type: 'state_gap', tick: 8, info: { missed: 2, after: 5 } },
        { type: 'state_out_of_order', tick: 7, info: { newest: 8 } },
      ])
    })

    it('records what the socket sends and receives once recording is on', () => {
      const sent = vi.fn()
      const received = vi.fn()
      const socket = mockSocket as typeof mockSocket & { connectionsManager?: unknown, bridge?: unknown }
      socket.connectionsManager = { emit: sent }
      socket.bridge = { emit: received }

      const nm = new NetworkManager({})
      const { connectionsManager, bridge } = socket as unknown as { connectionsManager: { emit(...args: unknown[]): void }, bridge: { emit(...args: unknown[]): void } }

      // Nothing is hooked into the socket before
      expect(connectionsManager.emit).toBe(sent)
      nm.net.enabled = true

      connectionsManager.emit('command', { type: 'cl_move', sequenceId: 0 })
      bridge.emit('sv_state', { tick: 1, ack: 0, entities: [] })

      expect(sent).toHaveBeenCalledWith('command', { type: 'cl_move', sequenceId: 0 })
      expect(received).toHaveBeenCalledWith('sv_state', { tick: 1, ack: 0, entities: [] })
      expect(nm.net.list().records).toMatchObject([
        { direction: 'out', type: 'command', sequenceId: 0, info: { command: 'cl_move' } },
        { direction: 'in', type: 'sv_state', tick: 1, info: { entities: 0, ack: 0 } },
      ])

      delete socket.connectionsManager
      delete socket.bridge
    })

    it('records from the start when the editor runs', () => {
      const nm = new NetworkManager({})
      expect(nm.net.enabled).toBe(false)
      mockGame.on.mock.calls[0][1]()
      expect(nm.net.enabled).toBe(true)
    })
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
