import { describe, expect, it, vi } from 'vitest'
import PluginHost from '../../src/Plugins/PluginHost'

interface TestPlugin {
  name?: string
  setup?(ctx: { pkg: string }): void
  tick?(delta: number, ctx: { pkg: string }): void
  assets?(ctx: { pkg: string }): string[]
}

function host(plugins: TestPlugin[], logger = {
  info: vi.fn(),
  error: vi.fn(),
}) {
  const loaded = plugins.map((plugin, i) => ({ package: `p${i}`, options: {}, plugin }))
  return {
    host: new PluginHost<TestPlugin, { pkg: string }>(loaded, p => ({ pkg: p.package }), logger as any, 'server'),
    logger,
  }
}

describe('pluginHost apis', () => {
  function apiHost(plugins: (TestPlugin & { api?(ctx: { pkg: string }): unknown })[]) {
    const logger = {
      info: vi.fn(),
      error: vi.fn(),
    }
    const loaded = plugins.map((plugin, i) => ({ package: `p${i}`, options: {}, plugin }))
    return {
      host: new PluginHost<typeof plugins[number], { pkg: string }>(loaded, p => ({ pkg: p.package }), logger as any, 'server'),
      logger,
    }
  }

  it('keeps what each plugin\'s api() returned, called with its context', () => {
    const mail = {
      send: vi.fn(),
    }
    const { host: h } = apiHost([
      {
        api: ctx => ({ ...mail, from: ctx.pkg }),
      },
      {},
      {
        api: () => undefined,
      },
    ])

    expect(h.api('p0')).toBeUndefined()
    h.exposeApis()

    expect(h.api('p0')).toEqual({ ...mail, from: 'p0' })
    expect(h.api('p1')).toBeUndefined()
    expect(h.api('p2')).toBeUndefined()
    expect(h.api('nope')).toBeUndefined()
  })

  it('has no api for a plugin whose api() threw, or that was removed', () => {
    const { host: h, logger } = apiHost([
      {
        api: () => {
          throw new Error('broken')
        },
      },
      {
        api: () => 'api',
      },
    ])

    h.exposeApis()

    expect(h.api('p0')).toBeUndefined()
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('failed in api()'))
    expect(h.api('p1')).toBe('api')

    h.remove('p1')
    expect(h.api('p1')).toBeUndefined()
  })
})

describe('pluginHost', () => {
  it('logs each plugin when it loads', () => {
    const { logger } = host([
      {},
      { name: 'Trees' },
    ])

    expect(logger.info).toHaveBeenCalledWith('Plugin loaded: p0 (server)')
    expect(logger.info).toHaveBeenCalledWith('Plugin loaded: Trees (p1) (server)')
  })

  it('calls hooks in order with the arguments and the plugin context', () => {
    const calls: string[] = []
    const { host: h } = host([
      {
        tick: (delta, ctx) => calls.push(`${ctx.pkg}:${delta}`),
      },
      {},
      {
        tick: (delta, ctx) => calls.push(`${ctx.pkg}:${delta}`),
      },
    ])

    h.run('tick', 0.5)

    expect(calls).toEqual(['p0:0.5', 'p2:0.5'])
  })

  it('lets the caller make each plugin\'s call, to tell what that plugin did', () => {
    const calls: string[] = []
    const { host: h } = host([
      {
        tick: (delta, ctx) => calls.push(`${ctx.pkg}:${delta}`),
      },
      {},
      {
        tick: () => {
          throw new Error('boom')
        },
      },
    ])

    h.runAround('tick', (plugin, call) => {
      calls.push(`before ${plugin.package}`)
      call()
      calls.push(`after ${plugin.package}`)
    }, 2)

    expect(calls).toEqual([
      'before p0',
      'p0:2',
      'after p0',
      'before p1',
      'after p1',
      'before p2',
      'after p2',
    ])
  })

  it('calls hooks with the plugin as this', () => {
    const plugin = {
      count: 0,
      setup() {
        this.count++
      },
    }
    const { host: h } = host([plugin])

    h.run('setup')

    expect(plugin.count).toBe(1)
  })

  it('turns a hook off for a plugin that throws, and keeps running the others', () => {
    const ok = vi.fn()
    const broken = vi.fn(() => {
      throw new Error('boom')
    })
    const { host: h, logger } = host([
      { tick: broken },
      { tick: ok },
    ])

    h.run('tick', 1)
    h.run('tick', 2)

    expect(broken).toHaveBeenCalledTimes(1)
    expect(ok).toHaveBeenCalledTimes(2)
    expect(logger.error).toHaveBeenCalledTimes(1)
    expect(logger.error.mock.calls[0][0]).toContain('Plugin p0 failed in tick(), turning that hook off: Error: boom')
  })

  it('collects results with the plugin that returned them', () => {
    const { host: h } = host([
      {
        assets: () => ['a'],
      },
      {},
      {
        assets: () => ['b'],
      },
    ])

    expect(h.collect('assets').map(r => [r.plugin.package, r.result])).toEqual([
      [
        'p0',
        ['a'],
      ],
      [
        'p2',
        ['b'],
      ],
    ])
  })

  it('gives a plugin\'s context until it is removed', () => {
    const { host: h } = host([{}, {}])

    expect(h.contextOf('p1')).toEqual({ pkg: 'p1' })
    expect(h.contextOf('nope')).toBeUndefined()
    h.remove('p1')
    expect(h.contextOf('p1')).toBeUndefined()
  })
})
