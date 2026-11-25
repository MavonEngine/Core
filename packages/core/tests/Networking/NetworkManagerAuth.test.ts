import { beforeEach, describe, expect, it, vi } from 'vitest'
import BaseGame from '../../src/BaseGame'
import NetworkManager from '../../src/Networking/Client/NetworkManager'
import PluginHost from '../../src/Plugins/PluginHost'

const socket = vi.hoisted(() => ({
  options: undefined as Record<string, unknown> | undefined,
  connect: undefined as ((error?: unknown) => void) | undefined,
  userData: {} as unknown,
}))

vi.mock('@geckos.io/client', () => ({
  geckos: vi.fn((options: Record<string, unknown>) => {
    socket.options = options
    return {
      get userData() {
        return socket.userData
      },
      on: vi.fn(),
      emit: vi.fn(),
      close: vi.fn(),
      onConnect: (callback: (error?: unknown) => void) => void (socket.connect = callback),
      onDisconnect: vi.fn(),
    }
  }),
}))

vi.mock('@dimforge/rapier3d-compat', () => ({
  version: vi.fn().mockReturnValue('0.0.0'),
}))

function useClientPlugins(plugins: { authorization?(): string | undefined, onConnectError?(error: unknown): void }[]) {
  const game = BaseGame.instance() as unknown as { plugins?: unknown }
  game.plugins = new PluginHost(plugins.map((plugin, i) => ({ package: `p${i}`, options: {}, plugin })), () => ({}), null, 'client')
}

describe('network manager auth', () => {
  beforeEach(() => {
    // eslint-disable-next-line no-new
    new BaseGame(null)
    socket.options = undefined
    socket.userData = {}
  })

  it('sends the authorization of the first client plugin that gives one', () => {
    useClientPlugins([
      {},
      {
        authorization: () => undefined,
      },
      {
        authorization: () => 'Bearer abc',
      },
      {
        authorization: () => 'Bearer later',
      },
    ])

    new NetworkManager({ url: 'http://localhost' }).destroy()

    expect(socket.options).toMatchObject({ url: 'http://localhost', authorization: 'Bearer abc' })
  })

  it('prefers the authorization the game passes, and sends none without either', () => {
    useClientPlugins([
      {
        authorization: () => 'Bearer abc',
      },
    ])
    new NetworkManager({ authorization: 'Bearer mine' }).destroy()
    expect(socket.options?.authorization).toBe('Bearer mine')

    useClientPlugins([])
    new NetworkManager({}).destroy()
    expect(socket.options?.authorization).toBeUndefined()
  })

  it('tells when the server turned it away, and who it was let in as', () => {
    useClientPlugins([])
    const network = new NetworkManager({})
    const refused = vi.fn()
    network.on('connectError', refused)

    socket.connect!({ message: 'Connection failed with status code 401.', status: 401, statusText: 'Unauthorized' })
    expect(refused).toHaveBeenCalledWith(expect.objectContaining({ status: 401 }))
    // Kept for whoever looks later, like the editor's panels, and cleared once connected
    expect(network.connectError?.status).toBe(401)
    expect(network.identity).toBeUndefined()
    socket.connect!()
    expect(network.connectError).toBeNull()

    socket.userData = { id: 'acc-1', name: 'alice' }
    expect(network.identity).toEqual({ id: 'acc-1', name: 'alice' })
    network.destroy()
  })

  it('tells the client plugins when connecting failed, so an auth plugin can forget a session the server turned away', () => {
    const onConnectError = vi.fn()
    useClientPlugins([
      {},
      { onConnectError },
    ])
    const network = new NetworkManager({})

    socket.connect!({ message: 'Connection failed with status code 401.', status: 401, statusText: 'Unauthorized' })
    expect(onConnectError).toHaveBeenCalledWith({ message: 'Connection failed with status code 401.', status: 401 }, {})

    // Not when it connects
    socket.connect!()
    expect(onConnectError).toHaveBeenCalledTimes(1)
    network.destroy()
  })
})
