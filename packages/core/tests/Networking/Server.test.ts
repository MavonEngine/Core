import type { ServerChannel } from '@geckos.io/server'
import type ServerWorld from '../../src/Networking/Server/World'
import { rmSync } from 'node:fs'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import winston from 'winston'
import Player from '../../src/Networking/Entities/Player'
import { ClientCommand, ServerCommand } from '../../src/Networking/Server/Commands'
import Server from '../../src/Networking/Server/Server'
import { clearSceneObjects, registerSceneObject } from '../../src/Scene/SceneObjectRegistry'
import GameObject from '../../src/World/GameObject'
import { installPlugin, tempProject, writeConfig, writeFile } from '../Plugins/fixtures'

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
    expect((server.game.world as ServerWorld).players[0].channel?.id).eq(randomId)

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

  it('moves the game socket onto the HTTP server when it serves the client', () => {
    const server = new TestServer(logger, undefined, { client: { root: '/game/client' } })
    const nodeServer = {}

    const listen = vi.fn()
    ;(server.gameSocket as any).listen = listen
    const addServer = vi.fn()
    ;(server.gameSocket as any).addServer = addServer
    vi.spyOn(server.http, 'start').mockImplementation(() => {})
    vi.spyOn(server.http, 'serveClient').mockReturnValue(true)
    vi.spyOn(server.http, 'server', 'get').mockReturnValue(nodeServer as any)

    server.start()
    server.stop()

    expect(addServer).toHaveBeenCalledWith(nodeServer)
    expect(listen).not.toHaveBeenCalled()
  })

  it('still opens the socket port when asked to while serving the client', () => {
    const server = new TestServer(logger, undefined, { client: { root: '/game/client' }, socketPort: 9001 })

    const listen = vi.fn()
    ;(server.gameSocket as any).listen = listen
    ;(server.gameSocket as any).addServer = vi.fn()
    vi.spyOn(server.http, 'start').mockImplementation(() => {})
    vi.spyOn(server.http, 'serveClient').mockReturnValue(true)
    vi.spyOn(server.http, 'server', 'get').mockReturnValue({} as any)

    server.start()
    server.stop()

    expect(listen).toHaveBeenCalledWith(9001)
  })

  it('falls back to port 8081 when the client is configured but not built', () => {
    const server = new TestServer(logger, undefined, { client: { root: '/game/client' } })

    const listen = vi.fn()
    ;(server.gameSocket as any).listen = listen
    const addServer = vi.fn()
    ;(server.gameSocket as any).addServer = addServer
    vi.spyOn(server.http, 'start').mockImplementation(() => {})
    vi.spyOn(server.http, 'serveClient').mockReturnValue(false)

    server.start()
    server.stop()

    expect(listen).toHaveBeenCalledWith(8081)
    expect(addServer).not.toHaveBeenCalled()
  })

  it('keeps the game socket on its own port when no client is served', () => {
    const server = new TestServer(logger)

    const listen = vi.fn()
    ;(server.gameSocket as any).listen = listen
    const addServer = vi.fn()
    ;(server.gameSocket as any).addServer = addServer
    vi.spyOn(server.http, 'start').mockImplementation(() => {})

    server.start()
    server.stop()

    expect(addServer).not.toHaveBeenCalled()
    expect(listen).toHaveBeenCalledWith(8081)
  })

  describe('plugins', () => {
    function startable(server: TestServer) {
      ;(server.gameSocket as any).listen = vi.fn()
      vi.spyOn(server.http, 'start').mockImplementation(() => {})
      return server
    }

    it('runs setup, then plugin routes after onHttp and before the client', async () => {
      const order: string[] = []
      const server = startable(new TestServer(logger, undefined, {
        plugins: [{
          name: 'routes',
          setup: ctx => order.push(`setup:${ctx.package}:${ctx.server === server}`),
          http: (app, ctx) => order.push(`http:${app === ctx.server.httpServer}`),
        }],
      }))
      server.onHttp(() => order.push('onHttp'))
      vi.spyOn(server.http, 'serveClient').mockImplementation(() => {
        order.push('client')
        return false
      })

      await server.start()
      server.stop()

      expect(order).toEqual(['setup:routes:true', 'onHttp', 'http:true', 'client'])
    })

    it('tells the routes of each plugin apart from the game\'s and the engine\'s', async () => {
      const handler = (_req: unknown, res: { end(): void }) => res.end()
      const server = startable(new TestServer(logger, undefined, {
        plugins: [
          { package: '@acme/chat', options: {}, plugin: { http: app => void app.get('/chat', handler) } },
          {
            package: 'shop',
            options: {},
            plugin: {
              setup: ctx => void ctx.server.httpServer.get('/shop/early', handler),
              http: app => void app.post('/shop', handler),
            },
          },
        ],
      }))
      server.onHttp(app => void app.get('/api/scores', handler))

      await server.start()
      server.stop()

      const routes = server.http.routes.list().map(({ method, path, source, plugin }) => ({ method, path, source, plugin }))
      expect(routes.filter(route => route.source !== 'engine')).toEqual([
        { method: 'GET', path: '/shop/early', source: 'plugin', plugin: 'shop' },
        { method: 'GET', path: '/api/scores', source: 'game', plugin: undefined },
        { method: 'GET', path: '/chat', source: 'plugin', plugin: '@acme/chat' },
        { method: 'POST', path: '/shop', source: 'plugin', plugin: 'shop' },
      ])
      expect(routes.some(route => route.source === 'engine' && route.path === '/api/game/routes')).toBe(true)
    })

    it('passes the options of loaded plugins to their context', async () => {
      const setup = vi.fn()
      const server = startable(new TestServer(logger, undefined, {
        plugins: [{ package: 'forest', options: { density: 2 }, plugin: { setup } }],
      }))

      await server.start()
      server.stop()

      expect(setup.mock.calls[0][0]).toMatchObject({ package: 'forest', options: { density: 2 } })
    })

    it('ticks plugins with the server and tells them about connections', () => {
      const tick = vi.fn()
      const onConnection = vi.fn()
      const onDisconnect = vi.fn()
      const server = startable(new TestServer(logger, undefined, { plugins: [{ tick, onConnection, onDisconnect }] }))
      server.start()

      let disconnect = () => {}
      const channel = { id: 'p1', on: vi.fn(), onDisconnect: (cb: () => void) => (disconnect = cb) }
      mockGeckosOnConnection.mock.calls[0][0](channel)
      server.game.update(0.1)
      disconnect()
      server.stop()

      expect(onConnection).toHaveBeenCalledWith(channel, expect.any(TestClient), expect.objectContaining({ server }))
      expect(tick).toHaveBeenCalledWith(0.1, expect.anything())
      expect(onDisconnect).toHaveBeenCalledWith(channel, expect.anything())
    })

    it('lists the project\'s plugins and says which of them it runs', async () => {
      const root = tempProject()
      installPlugin(root, 'probe', { target: 'server', server: './server.js' }, { 'server.js': 'export default {}', 'README.md': '# Probe' })
      installPlugin(root, 'hud', { target: 'client', client: './client.js', assets: { prefabs: { Bar: ['bar.png'] } } }, { 'client.js': 'export default {}' })
      writeConfig(root, { plugins: { probe: {}, hud: { prefabs: ['Bar'] }, gone: { enabled: false } } })
      const server = startable(new TestServer(logger, undefined, { plugins: { root } }))

      await server.start()
      const infos = server.pluginInfos()
      server.stop()
      rmSync(root, { recursive: true, force: true })

      expect(infos).toEqual([
        { package: 'probe', enabled: true, installed: true, version: '1.0.0', target: 'server', declaredPrefabs: [], usedPrefabs: [], runningOnServer: true },
        { package: 'hud', enabled: true, installed: true, version: '1.0.0', target: 'client', declaredPrefabs: ['Bar'], usedPrefabs: ['Bar'], runningOnServer: false },
        { package: 'gone', enabled: false, installed: false, problem: 'Listed in mavonengine.json but not installed', declaredPrefabs: [], usedPrefabs: [], runningOnServer: false },
      ])
    })

    it('lists plugins that were passed to it directly', async () => {
      const server = startable(new TestServer(logger, undefined, { plugins: [{ name: 'inline' }, { package: 'forest', options: {}, plugin: {} }] }))

      await server.start()
      const infos = server.pluginInfos()
      server.stop()

      expect(infos.map(info => [info.package, info.runningOnServer])).toEqual([['inline', true], ['forest', true]])
      // Nothing runs anymore
      expect(server.pluginInfos()).toEqual([])
    })

    it('tells plugins loaded from mavonengine.json their project root', async () => {
      const root = tempProject()
      installPlugin(root, 'probe', { target: 'server', server: './server.js' }, {
        'server.js': 'export default { setup(ctx) { globalThis.probeRoot = ctx.projectRoot } }',
      })
      writeConfig(root, { plugins: { probe: {} } })
      const server = startable(new TestServer(logger, undefined, { plugins: { root } }))

      await server.start()
      server.stop()
      rmSync(root, { recursive: true, force: true })

      expect((globalThis as any).probeRoot).toBe(root)
    })

    it('destroys plugins when it stops', () => {
      const destroy = vi.fn()
      const server = startable(new TestServer(logger, undefined, { plugins: [{ destroy }] }))

      server.start()
      server.stop()

      expect(destroy).toHaveBeenCalledTimes(1)
      expect(server.plugins).toBeUndefined()
    })
  })

  it('captures log output for the logs endpoint', () => {
    const logger = winston.createLogger({ level: 'info', transports: [] })
    const server = new TestServer(logger)

    logger.info('from the game')

    expect(server.logs!.since().entries.at(-1)).toMatchObject({ level: 'info', message: 'from the game' })
  })

  it('does not capture logs when logBufferSize is 0', () => {
    const logger = winston.createLogger({ transports: [] })
    const server = new TestServer(logger, undefined, { metrics: { logBufferSize: 0 } })

    expect(server.logs).toBeUndefined()
    expect(logger.transports).toHaveLength(0)
  })

  it('records HTTP requests unless requestLogSize is 0', () => {
    expect(new TestServer(logger).requests).toBeDefined()
    expect(new TestServer(logger, undefined, { metrics: { requestLogSize: 0 } }).requests).toBeUndefined()
  })

  describe('periodic stats logging', () => {
    function startServer() {
      const server = new TestServer(logger, undefined, { metrics: { logIntervalMs: 1000 } })
      ;(server.gameSocket as any).listen = vi.fn()
      vi.spyOn(server.http, 'start').mockImplementation(() => {})

      const cpuLog = vi.spyOn(server.metrics.cpu, 'log').mockImplementation(() => {})
      const info = vi.spyOn(logger, 'info')

      server.start()
      return { server, cpuLog, info }
    }

    afterEach(() => {
      vi.useRealTimers()
    })

    it('logs CPU / bandwidth when no dashboard is watching', () => {
      vi.useFakeTimers()
      const { server, cpuLog } = startServer()

      vi.advanceTimersByTime(1000)
      server.stop()

      expect(cpuLog).toHaveBeenCalledTimes(1)
    })

    it('pauses while a dashboard is fetching metrics and says so once', () => {
      vi.useFakeTimers()
      const { server, cpuLog, info } = startServer()
      const active = vi.spyOn(server.http, 'metricsClientActive').mockReturnValue(true)

      vi.advanceTimersByTime(3000)

      expect(cpuLog).not.toHaveBeenCalled()
      expect(info.mock.calls.filter(([msg]) => String(msg).includes('dashboard connected'))).toHaveLength(1)

      active.mockReturnValue(false)
      vi.advanceTimersByTime(1000)
      server.stop()

      expect(cpuLog).toHaveBeenCalledTimes(1)
      expect(info).toHaveBeenCalledWith(expect.stringContaining('dashboard disconnected'))
    })
  })

  describe('bandwidth', () => {
    function connect(id: string, counters: { sent: number, received: number }) {
      const handlers: Record<string, (...args: any[]) => void> = {}
      let disconnect = () => {}
      const peerConnection = { bytesSent: () => counters.sent, bytesReceived: () => counters.received }
      const channel = { id, emit: vi.fn(), on: (event: string, cb: () => void) => (handlers[event] = cb), onDisconnect: (cb: () => void) => (disconnect = cb), webrtcConnection: { peerConnection } }
      mockGeckosOnConnection.mock.calls[0][0](channel)
      mockGeckosServer.connectionsManager.connections.set(id, { channel })
      return { channel, handlers, disconnect: () => disconnect() }
    }

    function startServer() {
      const server = new TestServer(logger, undefined, { metrics: { sampleIntervalMs: 1000 } })
      ;(server.gameSocket as any).listen = vi.fn()
      vi.spyOn(server.http, 'start').mockImplementation(() => {})
      vi.spyOn(server.metrics.cpu, 'sample').mockImplementation(() => undefined as any)
      vi.spyOn(server, 'getStateSyncDistance').mockReturnValue(100)
      server.start()
      return server
    }

    afterEach(() => {
      vi.useRealTimers()
      mockGeckosServer.connectionsManager.connections = new Map()
    })

    it('samples what the connections sent and received from the transport\'s counters', () => {
      vi.useFakeTimers()
      const server = startServer()
      const one = { sent: 1000, received: 200 }
      const two = { sent: 50, received: 5 }
      connect('p1', one)
      connect('p2', two)

      vi.advanceTimersByTime(1000)
      expect(server.bandwidthTracker.history.at(-1)).toMatchObject({ sent: 1050, received: 205 })

      // Only what was added since the last sample counts
      one.sent += 300
      two.received += 20
      vi.advanceTimersByTime(1000)
      server.stop()

      expect(server.bandwidthTracker.history.at(-1)).toMatchObject({ sent: 300, received: 20 })
    })

    it('counts the last bytes of a connection that closed between two samples', () => {
      vi.useFakeTimers()
      const server = startServer()
      const counters = { sent: 100, received: 10 }
      const { disconnect } = connect('p1', counters)

      vi.advanceTimersByTime(1000)
      counters.sent += 40
      counters.received += 4
      disconnect()
      mockGeckosServer.connectionsManager.connections.delete('p1')
      vi.advanceTimersByTime(1000)
      server.stop()

      expect(server.bandwidthTracker.history.at(-1)).toMatchObject({ sent: 40, received: 4 })
    })

    it('skips a connection whose counters cannot be read', () => {
      vi.useFakeTimers()
      const server = startServer()
      const { channel } = connect('p1', { sent: 100, received: 10 })
      channel.webrtcConnection.peerConnection.bytesSent = () => {
        throw new Error('closed')
      }
      // Without a WebRTC connection, like a mocked channel
      mockGeckosServer.connectionsManager.connections.set('p2', { channel: { id: 'p2', emit: vi.fn() } })

      vi.advanceTimersByTime(1000)
      server.stop()

      expect(server.bandwidthTracker.history.at(-1)).toMatchObject({ sent: 0, received: 0 })
    })

    it('does not serialize a state just to measure it', () => {
      const server = new TestServer(logger)
      vi.spyOn(server, 'getStateSyncDistance').mockReturnValue(100)
      const player = new TestClient('p1')
      const toJSON = vi.fn(() => player.serialize())
      ;(player as any).toJSON = toJSON
      server.game.world.entities.items.set('p1', player)
      mockGeckosServer.connectionsManager.connections = new Map([['p1', { channel: { id: 'p1', emit: vi.fn() } }]])

      server.net.enabled = false
      ;(server as any).stateSync()
      expect(toJSON).not.toHaveBeenCalled()

      // The dev tools show the packet, so they need it serialized
      server.net.enabled = true
      ;(server as any).stateSync()
      expect(toJSON).toHaveBeenCalled()
    })
  })

  describe('editor clients', () => {
    function connect(id: string) {
      const handlers: Record<string, (...args: any[]) => void> = {}
      let disconnect = () => {}
      const emit = vi.fn()
      const channel = { id, emit, on: (event: string, cb: () => void) => (handlers[event] = cb), onDisconnect: (cb: () => void) => (disconnect = cb) }
      mockGeckosOnConnection.mock.calls[0][0](channel)
      mockGeckosServer.connectionsManager.connections.set(id, { channel })
      return { channel, handlers, disconnect: () => disconnect() }
    }

    afterEach(() => {
      mockGeckosServer.connectionsManager.connections = new Map()
    })

    it('stops being a player when it opens the editor, so metrics and other players no longer see it', () => {
      const server = new TestServer(logger)
      const other = connect('player')
      const editor = connect('editor')
      expect(server.metrics.snapshot().players).toHaveLength(2)

      editor.handlers[ClientCommand.CL_EDITOR]()

      expect(server.editorChannels.has('editor')).toBe(true)
      expect(server.game.world.entities.items.has('editor')).toBe(false)
      expect((server.game.world as ServerWorld).players.map(p => p.id)).toEqual(['player'])
      expect(server.metrics.snapshot().players.map(p => p.id)).toEqual(['player'])
      expect(server.metrics.health().players).toBe(1)
      expect(other.channel.emit).toHaveBeenCalledWith(ServerCommand.SV_REMOVE_ENTITY, { id: 'editor' })

      // A second announcement changes nothing
      editor.handlers[ClientCommand.CL_EDITOR]()
      expect(other.channel.emit).toHaveBeenCalledTimes(1)
    })

    it('sends the editor every entity, however far away', () => {
      const server = new TestServer(logger)
      server.getStateSyncDistance = () => 10
      const editor = connect('editor')
      editor.handlers[ClientCommand.CL_EDITOR]()
      const far = new TestClient('far')
      far.position.set(1000, 0, 0)
      server.game.world.entities.items.set('far', far)

      ;(server as any).stateSync()

      const [, state] = editor.channel.emit.mock.calls.find(([event]) => event === ServerCommand.SV_STATE)!
      expect(state.entities.map((e: GameObject) => e.id)).toEqual(['far'])
    })

    it('tells the editor when a player leaves, and forgets the editor when it disconnects', () => {
      const server = new TestServer(logger)
      const player = connect('player')
      const editor = connect('editor')
      editor.handlers[ClientCommand.CL_EDITOR]()

      player.disconnect()
      expect(editor.channel.emit).toHaveBeenCalledWith(ServerCommand.SV_REMOVE_ENTITY, { id: 'player' })

      editor.disconnect()
      expect(server.editorChannels.size).toBe(0)
    })
  })

  describe('network debugging', () => {
    /** A channel with the parts of a geckos channel the recorder hooks into */
    function connect(id: string) {
      const handlers: Record<string, (...args: any[]) => void> = {}
      let drop = (_drop: { reason: string, event: string }) => {}
      const sent = vi.fn()
      const channel = {
        id,
        _emit: sent,
        emit(event: string, data?: unknown) {
          this._emit(event, data)
        },
        eventEmitter: {
          emit: (event: string, data?: unknown) => handlers[event]?.(data),
        },
        on: (event: string, cb: () => void) => (handlers[event] = cb),
        onDisconnect: (cb: () => void) => (handlers.disconnect = cb),
        onDrop: (cb: typeof drop) => (drop = cb),
      }
      mockGeckosOnConnection.mock.calls[0][0](channel)
      mockGeckosServer.connectionsManager.connections.set(id, { channel })
      return { channel, sent, handlers, drop: (reason: string, event: string) => drop({ reason, event }) }
    }

    afterEach(() => {
      mockGeckosServer.connectionsManager.connections = new Map()
      vi.unstubAllEnvs()
    })

    function syncedServer() {
      const server = new TestServer(logger)
      server.getStateSyncDistance = () => 10
      return server
    }

    it('stamps every state with the tick, the server time and the player\'s last processed input', () => {
      const server = syncedServer()
      const { sent } = connect('p1')
      ;(server.game.world.entities.items.get('p1') as TestClient).updateLastProcessedSequenceId(41)

      server.game.update(0.1)
      server.game.update(0.1)

      const states = sent.mock.calls.filter(([event]) => event === ServerCommand.SV_STATE).map(([, state]) => state)
      expect(states.map(state => state.tick)).toEqual([1, 2])
      expect(states[1]).toMatchObject({ type: ServerCommand.SV_STATE, ack: 41, sequenceId: 0 })
      expect(Math.abs(states[1].serverTime - Date.now())).toBeLessThan(1000)
      expect(server.tickCount).toBe(2)
    })

    it('sends an editor a null ack', () => {
      const server = syncedServer()
      const editor = connect('editor')
      editor.handlers[ClientCommand.CL_EDITOR]()

      server.game.update(0.1)

      const [, state] = editor.sent.mock.calls.find(([event]) => event === ServerCommand.SV_STATE)!
      expect(state).toMatchObject({ tick: 1, ack: null })
    })

    it('records what each client is sent and sends, and the events of its connection', () => {
      const server = syncedServer()
      const { channel, handlers, drop } = connect('p1')

      channel.eventEmitter.emit('command', { type: 'cl_move', sequenceId: 3 })
      channel.eventEmitter.emit('ping')
      server.game.update(0.1)
      drop('DROPPED_FROM_BUFFERING', 'sv_state')
      handlers.disconnect()

      const records = server.net.list().records.map(({ kind, direction, type, peer, tick, sequenceId, info }) => ({ kind, direction, type, peer, tick, sequenceId, info }))
      expect(records).toEqual([
        { kind: 'event', direction: undefined, type: 'connect', peer: 'p1', tick: undefined, sequenceId: undefined, info: undefined },
        { kind: 'packet', direction: 'in', type: 'command', peer: 'p1', tick: undefined, sequenceId: 3, info: { command: 'cl_move' } },
        { kind: 'packet', direction: 'in', type: 'ping', peer: 'p1', tick: undefined, sequenceId: undefined, info: undefined },
        { kind: 'packet', direction: 'out', type: 'pong', peer: 'p1', tick: undefined, sequenceId: undefined, info: undefined },
        { kind: 'event', direction: undefined, type: 'sync_enter', peer: 'p1', tick: 1, sequenceId: undefined, info: { count: 1, entities: ['p1'] } },
        { kind: 'packet', direction: 'out', type: 'sv_state', peer: 'p1', tick: 1, sequenceId: undefined, info: { entities: 1, ack: 3 } },
        { kind: 'event', direction: undefined, type: 'dropped', peer: 'p1', tick: undefined, sequenceId: undefined, info: { reason: 'DROPPED_FROM_BUFFERING', message: 'sv_state' } },
        { kind: 'event', direction: undefined, type: 'disconnect', peer: 'p1', tick: undefined, sequenceId: undefined, info: undefined },
      ])

      const state = server.net.list({ type: 'sv_state' }).records[0]
      expect(server.net.get(state.id)).toMatchObject({ payload: { tick: 1, ack: 3, entities: [{ id: 'p1' }] } })
      expect(state.bytes).toBe(JSON.stringify(server.net.get(state.id)!.payload).length)
    })

    it('records entities entering and leaving a player\'s sync distance', () => {
      const server = syncedServer()
      connect('p1')
      const rock = new TestClient('rock')
      rock.position.set(5, 0, 0)
      server.game.world.entities.items.set('rock', rock)

      server.game.update(0.1)
      rock.position.set(50, 0, 0)
      server.game.update(0.1)

      expect(server.net.list({ kind: 'event', type: 'sync_enter,sync_leave' }).records).toMatchObject([
        { type: 'sync_enter', peer: 'p1', tick: 1, info: { count: 2, entities: ['p1', 'rock'] } },
        { type: 'sync_leave', peer: 'p1', tick: 2, info: { count: 1, entities: ['rock'] } },
      ])
    })

    it('describes the state sync', () => {
      const server = syncedServer()
      connect('p1')
      const near = new TestClient('near')
      near.position.set(5, 0, 0)
      const far = new TestClient('far')
      far.position.set(500, 0, 0)
      server.game.world.entities.items.set('near', near)
      server.game.world.entities.items.set('far', far)

      server.game.update(0.1)
      const sync = server.syncSnapshot()

      expect(sync).toMatchObject({ tick: 1, tickRate: server.game.tickRate, syncDistance: 10, editors: [] })
      expect(sync.players).toHaveLength(3)
      expect(sync.players[0]).toMatchObject({ id: 'p1', ack: 0, tracked: ['p1', 'near'], lastState: { tick: 1, entities: 2 } })
      expect(sync.players[0].lastState!.bytes).toBeGreaterThan(0)
      // near and far are players without a connection here, so they track what is around them but are sent nothing
      expect(sync.players[2]).toMatchObject({ id: 'far', lastState: null })

      expect(sync.entities.map(({ id, trackedBy, lastSentTick, position }) => ({ id, trackedBy, lastSentTick, x: position.x }))).toEqual([
        { id: 'p1', trackedBy: 1, lastSentTick: 1, x: 0 },
        { id: 'near', trackedBy: 1, lastSentTick: 1, x: 5 },
        { id: 'far', trackedBy: 0, lastSentTick: null, x: 500 },
      ])
    })

    it('tells when the game\'s server has no sync distance', () => {
      const server = new TestServer(logger)
      expect(server.syncSnapshot()).toMatchObject({ tick: 0, syncDistance: null, players: [], entities: [] })
    })

    it('records nothing in production', () => {
      vi.stubEnv('NODE_ENV', 'production')
      const server = syncedServer()
      const { channel, sent } = connect('p1')

      channel.eventEmitter.emit('ping')
      server.game.update(0.1)

      expect(server.net.enabled).toBe(false)
      expect(server.net.latestId).toBe(0)
      // The channel is left as it was
      expect(channel._emit).toBe(sent)
      expect(sent).toHaveBeenCalledWith(ServerCommand.SV_STATE, expect.objectContaining({ tick: 1 }))
    })
  })

  describe('scenes', () => {
    class Crate extends GameObject {
      update(): void {}
    }

    let root: string
    beforeEach(() => {
      root = tempProject()
      registerSceneObject({ type: 'Crate', server: () => new Crate() })
      writeFile(join(root, 'scenes', 'main.json'), JSON.stringify({
        version: 1,
        name: 'main',
        objects: [
          { id: 'crate', type: 'Crate', transform: { position: [1, 2, 3] } },
          { id: 'light', type: 'Light:AmbientLight' },
        ],
      }))
    })

    afterEach(() => {
      clearSceneObjects()
      rmSync(root, { recursive: true, force: true })
    })

    it('builds only the objects with a server factory from <root>/scenes/<name>.json', () => {
      const server = new TestServer(logger, undefined, { root })
      const loaded = vi.fn()
      server.game.on('sceneLoaded', loaded)

      const scene = server.openScene('main', { watch: false })

      expect(server.game.activeScene).toBe(scene)
      expect(loaded).toHaveBeenCalledWith(scene)
      expect(server.game.world.entities.items.get('crate')?.position.toArray()).toEqual([1, 2, 3])
      expect(server.game.world.entities.items.has('light')).toBe(false)
      expect(scene.serialize().objects.map(o => o.id)).toEqual(['crate', 'light'])
    })

    it('reloads the scene when its file changes', async () => {
      const server = new TestServer(logger, undefined, { root })
      server.openScene('main', { watch: true })
      const loaded = vi.fn()
      server.game.on('sceneLoaded', loaded)

      writeFile(join(root, 'scenes', 'main.json'), JSON.stringify({ objects: [{ id: 'crate2', type: 'Crate' }] }))

      await vi.waitFor(() => expect(loaded).toHaveBeenCalled(), { timeout: 3000 })
      server.stop()
      expect([...server.game.world.entities.items.keys()]).toEqual(['crate2'])
    })

    it('keeps the current scene when the changed file is invalid', async () => {
      const server = new TestServer(logger, undefined, { root })
      const errors = vi.spyOn(logger, 'error')
      server.openScene('main', { watch: true })

      writeFile(join(root, 'scenes', 'main.json'), '{ not json')

      await vi.waitFor(() => expect(errors).toHaveBeenCalled(), { timeout: 3000 })
      server.stop()
      expect(server.game.world.entities.items.has('crate')).toBe(true)
    })

    it('does not send scene objects in the state, they are not networked', () => {
      const server = new TestServer(logger, undefined, { root })
      server.getStateSyncDistance = () => 100
      server.openScene('main', { watch: false })
      const emit = vi.fn()
      mockGeckosServer.connectionsManager.connections = new Map([['p1', { channel: { emit } }]])
      server.game.world.entities.items.set('p1', new TestClient('p1'))

      ;(server as any).stateSync()
      mockGeckosServer.connectionsManager.connections = new Map()

      const [, state] = emit.mock.calls[0]
      expect(state.entities.map((e: GameObject) => e.id)).toEqual(['p1'])
    })

    it('needs a root for scene names', () => {
      const server = new TestServer(logger)
      expect(() => server.openScene('main')).toThrow('set the server\'s `root` option')
    })
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
