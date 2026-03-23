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
})
