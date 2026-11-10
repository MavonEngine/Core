import { PLUGIN_REGISTRY_URL } from '@mavonengine/core/Plugins/registry'
import { afterEach, describe, expect, it, vi } from 'vitest'
import AvailablePlugins from '../src/dashboard/available'

const forest = { package: 'forest', name: 'forest' }

afterEach(() => {
  vi.unstubAllEnvs()
})

describe('availablePlugins', () => {
  it('asks for nothing until it is told to load', async () => {
    const fetchRegistry = vi.fn(async () => ({ plugins: [forest] }))
    const available = new AvailablePlugins('https://example.com/list.json', fetchRegistry)
    const changed = vi.fn()
    available.onChange(changed)

    expect(available.state).toEqual({ status: 'idle', url: 'https://example.com/list.json', plugins: [], error: null })
    expect(fetchRegistry).not.toHaveBeenCalled()

    await available.load()

    expect(fetchRegistry).toHaveBeenCalledWith('https://example.com/list.json')
    expect(available.state).toMatchObject({ status: 'ready', plugins: [forest], error: null })
    expect(changed).toHaveBeenCalledTimes(1)
  })

  it('loads once, unless it is forced to read the list again', async () => {
    const fetchRegistry = vi.fn(async () => ({ plugins: [forest] }))
    const available = new AvailablePlugins('x', fetchRegistry)

    // Drawn every frame while the first answer is on its way
    void available.load()
    await available.load()
    await available.load()
    expect(fetchRegistry).toHaveBeenCalledTimes(1)

    await available.load(true)
    expect(fetchRegistry).toHaveBeenCalledTimes(2)
  })

  it('keeps what it had when reading the list again fails, and says why', async () => {
    let fail = false
    const available = new AvailablePlugins('x', async () => {
      if (fail)
        throw new Error('x was not found')
      return { plugins: [forest] }
    })

    await available.load()
    fail = true
    await available.load(true)

    expect(available.state).toMatchObject({ status: 'error', error: 'x was not found', plugins: [forest] })

    fail = false
    await available.load(true)
    expect(available.state).toMatchObject({ status: 'ready', error: null })
  })

  it('reads the list from GitHub, or from MAVONENGINE_PLUGINS_URL', () => {
    vi.stubEnv('MAVONENGINE_PLUGINS_URL', '')
    delete process.env.MAVONENGINE_PLUGINS_URL
    expect(new AvailablePlugins().state.url).toBe(PLUGIN_REGISTRY_URL)

    vi.stubEnv('MAVONENGINE_PLUGINS_URL', 'https://example.com/fork.json')
    expect(new AvailablePlugins().state.url).toBe('https://example.com/fork.json')
  })
})
