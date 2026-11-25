import type { ServerChannel } from '@geckos.io/server'
import type { IncomingMessage } from 'node:http'
import type { AuthorizeResult, LoadedPlugin, ServerPlugin, ServerPluginContext } from '../../src/Plugins/types'
import geckos from '@geckos.io/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import winston from 'winston'
import Player from '../../src/Networking/Entities/Player'
import Server from '../../src/Networking/Server/Server'
import { memoryDb } from '../Plugins/Database/memoryDb'
import { tempProject, writeConfig } from '../Plugins/fixtures'

vi.mock('@geckos.io/server', () => ({
  default: vi.fn(() => ({
    onConnection: vi.fn(),
    connectionsManager: {
      connections: new Map(),
    },
    emit: vi.fn(),
    listen: vi.fn(),
  })),
}))

class TestClient extends Player {
  update(_delta: number): void { }
  updateFromNetwork(_data: object): void { }
}

class TestServer extends Server<TestClient> {
  getStateSyncDistance(): number {
    return 0
  }

  protected onCommand(_command: any, _delta: number): void { }

  protected onConnection(channel: ServerChannel): TestClient {
    return new TestClient(channel.id)
  }
}

type Authorize = (authorization: string | undefined, request: IncomingMessage) => Promise<unknown>

const request = {} as IncomingMessage

function authPlugin(pkg: string, authorize: (header: string | undefined, req: IncomingMessage, ctx: ServerPluginContext) => AuthorizeResult | Promise<AuthorizeResult>, extra: Partial<ServerPlugin> = {}): LoadedPlugin<ServerPlugin> {
  return {
    package: pkg,
    options: { secret: 'letmein' },
    plugin: { authorize, ...extra },
  }
}

/** Accepts `Bearer letmein` as alice */
const tokenAuth = authPlugin('@mavonengine/auth', (header, _req, ctx) =>
  header === `Bearer ${ctx.options.secret}`
    ? { id: 'acc-1', name: 'alice' }
    : false)

describe('server auth', () => {
  let logger: winston.Logger

  beforeEach(() => {
    logger = winston.createLogger({ transports: [], silent: true })
    vi.mocked(geckos).mockClear()
  })

  /** The server, started, and the authorization callback it gave geckos */
  async function started(options: ConstructorParameters<typeof TestServer>[2]) {
    const server = new TestServer(logger, undefined, { stopOnSignals: false, ...options })
    vi.spyOn(server.http, 'start').mockImplementation(() => {})
    const authorize = vi.mocked(geckos).mock.calls.at(-1)![0]!.authorization as Authorize
    await server.start()
    return { server, authorize }
  }

  it('lets every client in without an auth plugin', async () => {
    const { server, authorize } = await started({
      plugins: [
        {
          setup: () => {},
        },
      ],
    })

    expect(server.authProvider).toBeUndefined()
    expect(await authorize(undefined, request)).toBe(true)
    expect(await authorize('Bearer anything', request)).toBe(true)
    await server.stop()
  })

  it('asks the auth plugin, with its context, and turns away who it refuses', async () => {
    const { server, authorize } = await started({
      plugins: [tokenAuth],
    })

    expect(server.authProvider).toBe('@mavonengine/auth')
    expect(await authorize('Bearer letmein', request)).toEqual({ id: 'acc-1', name: 'alice' })
    expect(await authorize('Bearer wrong', request)).toBe(401)
    expect(await authorize(undefined, request)).toBe(401)
    await server.stop()
  })

  it('passes on true, a refusing HTTP status and async results', async () => {
    const results: AuthorizeResult[] = [true, 403, 451]
    const { server, authorize } = await started({
      plugins: [
        authPlugin('auth', async () => results.shift()!),
      ],
    })

    expect(await authorize(undefined, request)).toBe(true)
    expect(await authorize(undefined, request)).toBe(403)
    expect(await authorize(undefined, request)).toBe(451)
    await server.stop()
  })

  it('turns the client away with 500 when the plugin throws or returns nonsense, and keeps asking it', async () => {
    const error = vi.spyOn(logger, 'error')
    const results: unknown[] = [
      { name: 'no id' },
      200,
      'yes',
      { id: '' },
    ]
    let calls = 0
    const { server, authorize } = await started({
      plugins: [
        authPlugin('auth', () => {
          calls++
          if (calls === 1)
            throw new Error('bad header')
          return results.length
            ? results.shift() as AuthorizeResult
            : { id: 'acc-2' }
        }),
      ],
    })

    expect(await authorize('x', request)).toBe(500)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('failed in authorize(), turning the client away'))
    for (let i = 0; i < 4; i++)
      expect(await authorize('x', request)).toBe(500)
    expect(error).toHaveBeenCalledWith(expect.stringContaining('which is no identity, boolean or HTTP status'))
    // A throw doesn't turn the hook off the way other hooks are
    expect(await authorize('x', request)).toEqual({ id: 'acc-2' })
    await server.stop()
  })

  it('picks the auth plugin from the options, the config or else the first', async () => {
    const a = authPlugin('auth-a', () => ({ id: 'a' }))
    const b = authPlugin('auth-b', () => ({ id: 'b' }))
    const warn = vi.spyOn(logger, 'warn')

    const first = await started({
      plugins: [a, b],
    })
    expect(await first.authorize(undefined, request)).toEqual({ id: 'a' })
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('More than one auth plugin is enabled (auth-a, auth-b), using auth-a'))
    await first.server.stop()

    const picked = await started({
      plugins: [a, b],
      auth: 'auth-b',
    })
    expect(await picked.authorize(undefined, request)).toEqual({ id: 'b' })
    await picked.server.stop()

    const root = tempProject()
    writeConfig(root, { plugins: {}, auth: 'auth-b' })
    const fromConfig = await started({
      plugins: [a, b],
      root,
    })
    expect(fromConfig.server.authProvider).toBe('auth-b')
    await fromConfig.server.stop()
  })

  it('turns every client away when the auth plugin the project names isn\'t running', async () => {
    const error = vi.spyOn(logger, 'error')

    const other = await started({
      plugins: [
        authPlugin('auth-a', () => true),
      ],
      auth: 'auth-b',
    })
    expect(error).toHaveBeenCalledWith(expect.stringContaining('Auth plugin auth-b is not running, so every client is turned away'))
    expect(await other.authorize('x', request)).toBe(503)
    await other.server.stop()

    const none = await started({
      plugins: [
        {
          setup: () => {},
        },
      ],
      auth: 'auth-b',
    })
    expect(error).toHaveBeenCalledWith('The project\'s auth plugin is not running, so every client is turned away')
    expect(await none.authorize('x', request)).toBe(503)
    await none.server.stop()
  })

  it('turns every client away when the auth plugin\'s migration failed, instead of letting them in', async () => {
    const failing = authPlugin('@mavonengine/auth', () => ({ id: 'a' }), {
      migrations: {
        '001_init': {
          up: async () => { throw new Error('disk full') },
        },
      },
    })
    const { server, authorize } = await started({
      plugins: [
        {
          package: 'db',
          options: {},
          plugin: {
            database: () => memoryDb(),
          },
        },
        failing,
      ],
    })

    expect(server.plugins?.plugins.map(p => p.package)).toEqual(['db'])
    expect(server.authProvider).toBeUndefined()
    expect(await authorize('Bearer letmein', request)).toBe(503)
    await server.stop()
  })

  it('marks the auth plugin in the plugin list', async () => {
    const { server } = await started({
      plugins: [
        tokenAuth,
        { name: 'other' },
      ],
    })

    const infos = server.pluginInfos()
    expect(infos.find(info => info.package === '@mavonengine/auth')?.auth).toBe(true)
    expect(infos.find(info => info.package === 'other')?.auth).toBeUndefined()
    await server.stop()
  })

  it('gives plugins and players the identity of a channel', async () => {
    const contexts: ServerPluginContext[] = []
    const { server } = await started({
      plugins: [
        tokenAuth,
        {
          setup: ctx => void contexts.push(ctx),
        },
      ],
    })

    const channel = {
      id: 'chan-1',
      userData: { id: 'acc-1', name: 'alice' },
    } as unknown as ServerChannel
    const guest = { id: 'chan-2', userData: {} } as unknown as ServerChannel
    expect(contexts[0].identity(channel)).toEqual({ id: 'acc-1', name: 'alice' })
    expect(contexts[0].identity(guest)).toBeUndefined()

    const player = new TestClient('chan-1')
    expect(player.identity).toBeUndefined()
    player.channel = channel
    expect(player.identity?.id).toBe('acc-1')
    await server.stop()
  })
})
