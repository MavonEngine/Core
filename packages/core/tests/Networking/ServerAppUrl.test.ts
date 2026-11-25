import type { ServerChannel } from '@geckos.io/server'
import type { ServerPluginContext } from '../../src/Plugins/types'
import type GameObject from '../../src/World/GameObject'
import { rmSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import winston from 'winston'
import Server from '../../src/Networking/Server/Server'
import { APP_URL_ENV, parseAppUrl } from '../../src/Plugins/ProjectConfig'
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

class TestServer extends Server<GameObject> {
  getStateSyncDistance(): number {
    return 0
  }

  protected onCommand(): void {}

  protected onConnection(_channel: ServerChannel): GameObject {
    throw new Error('not used')
  }
}

const roots: string[] = []

afterEach(() => {
  vi.unstubAllEnvs()
  roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true }))
})

const logger = winston.createLogger({ transports: [], silent: true })

describe('the game\'s address and name', () => {
  it('is appUrl in mavonengine.json, the option over it, the environment over both, and plugins get it', async () => {
    const root = tempProject()
    roots.push(root)
    writeConfig(root, { plugins: {}, appUrl: 'https://config.example.com/', appName: ' Space Game ' })

    let ctx: ServerPluginContext | undefined
    const server = new TestServer(logger, undefined, {
      stopOnSignals: false,
      root,
      plugins: [
        {
          name: 'p',
          setup: c => void (ctx = c),
        },
      ],
    })
    vi.spyOn(server.http, 'start').mockImplementation(() => {})
    await server.start()

    expect(server.appUrl).toBe('https://config.example.com')
    expect(ctx!.appUrl).toBe('https://config.example.com')
    expect(server.appName).toBe('Space Game')
    expect(ctx!.appName).toBe('Space Game')

    vi.stubEnv(APP_URL_ENV, 'https://env.example.com')
    // Read when asked, so a plugin sees what is set now
    expect(ctx!.appUrl).toBe('https://env.example.com')
    await server.stop()

    vi.unstubAllEnvs()
    const withOption = new TestServer(logger, undefined, { stopOnSignals: false, root, appUrl: 'https://option.example.com' })
    expect(withOption.appUrl).toBe('https://option.example.com')
    expect(new TestServer(logger, undefined, { stopOnSignals: false, root, appName: 'Other Game' }).appName).toBe('Other Game')
  })

  it('is undefined without one, or for one that is no http(s) URL', () => {
    expect(new TestServer(logger, undefined, { stopOnSignals: false }).appUrl).toBeUndefined()
    expect(new TestServer(logger, undefined, { stopOnSignals: false, appName: '  ' }).appName).toBeUndefined()
    expect(new TestServer(logger, undefined, { stopOnSignals: false, appUrl: 'javascript:alert(1)' }).appUrl).toBeUndefined()

    expect(parseAppUrl(' https://a.example.com/game// ')).toBe('https://a.example.com/game')
    expect(parseAppUrl('http://localhost:8050')).toBe('http://localhost:8050')
    for (const bad of [
      '',
      'mygame.com',
      'ftp://a.example.com',
      42,
      undefined,
    ])
      expect(parseAppUrl(bad)).toBeUndefined()
  })
})
