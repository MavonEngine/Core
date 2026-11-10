import { describe, expect, it, vi } from 'vitest'
import { parseDashboardArgs, UsageError } from '../src/commands/dashboard'

describe('parseDashboardArgs', () => {
  it('defaults to the local server', () => {
    const options = parseDashboardArgs([], {})

    expect(options).not.toBe('help')
    if (options === 'help')
      return

    expect(options.source.label).toBe('http://localhost:8050/api/game/metrics')
    expect(options.intervalMs).toBe(1000)
  })

  it('builds the url from host and port', () => {
    const options = parseDashboardArgs(['--host', 'game.example.com', '--port', '9000'], {})

    expect(options !== 'help' && options.source.label).toBe('http://game.example.com:9000/api/game/metrics')
  })

  it('wraps IPv6 hosts in brackets', () => {
    const options = parseDashboardArgs(['--host', '::1'], {})

    expect(options !== 'help' && options.source.label).toBe('http://[::1]:8050/api/game/metrics')
  })

  it('opens the client from the root of the metrics server', () => {
    const local = parseDashboardArgs(['--port', '9000'], {})
    const proxied = parseDashboardArgs(['--url', 'https://game.example.com/api/game/metrics'], {})
    const sim = parseDashboardArgs(['--sim'], {})

    expect(local !== 'help' && local.clientUrl).toBe('http://localhost:9000/')
    expect(proxied !== 'help' && proxied.clientUrl).toBe('https://game.example.com/')
    expect(sim !== 'help' && sim.clientUrl).toBeUndefined()
  })

  it('uses --url as is', () => {
    const options = parseDashboardArgs(['--url', 'https://game.example.com/api/game/metrics'], {})

    expect(options !== 'help' && options.source.label).toBe('https://game.example.com/api/game/metrics')
  })

  it('is opaque unless --transparent is passed', () => {
    const opaque = parseDashboardArgs([], {})
    const transparent = parseDashboardArgs(['--transparent'], {})

    expect(opaque !== 'help' && opaque.transparent).toBe(false)
    expect(transparent !== 'help' && transparent.transparent).toBe(true)
  })

  it('switches to the simulator with --sim', () => {
    const options = parseDashboardArgs(['--sim'], {})

    expect(options !== 'help' && options.source.label).toBe('simulation')
  })

  it('returns help', () => {
    expect(parseDashboardArgs(['--help'], {})).toBe('help')
    expect(parseDashboardArgs(['-h'], {})).toBe('help')
  })

  it.each([
    [['--port', '0']],
    [['--port', 'abc']],
    [['--interval', '10']],
    [['--url', 'not a url']],
  ])('rejects %j', (args) => {
    expect(() => parseDashboardArgs(args, {})).toThrow(UsageError)
  })

  it('rejects unknown flags', () => {
    expect(() => parseDashboardArgs(['--nope'], {})).toThrow()
  })

  it('sends the metrics token, or else the server\'s admin token, which reads the metrics too', async () => {
    const sent: (string | undefined)[] = []
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      sent.push((init?.headers as Record<string, string> | undefined)?.Authorization)
      return Response.json({})
    })

    const tokenOf = async (args: string[], env: Record<string, string>) => {
      const options = parseDashboardArgs(args, env)
      if (options === 'help')
        throw new Error('unexpected help')
      await options.source.fetch()
      return sent.at(-1)
    }

    expect(await tokenOf([], {})).toBeUndefined()
    expect(await tokenOf([], { MAVONENGINE_ADMIN_TOKEN: 'admin' })).toBe('Bearer admin')
    expect(await tokenOf([], { MAVONENGINE_METRICS_TOKEN: 'metrics', MAVONENGINE_ADMIN_TOKEN: 'admin' })).toBe('Bearer metrics')
    expect(await tokenOf(['--token', 'flag'], { MAVONENGINE_METRICS_TOKEN: 'metrics', MAVONENGINE_ADMIN_TOKEN: 'admin' })).toBe('Bearer flag')

    fetch.mockRestore()
  })
})
