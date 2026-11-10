import type { PluginInfo } from '../../../src/Editor/Plugins/pluginsApi'
import { describe, expect, it, vi } from 'vitest'
import { fetchPlugins, pluginPrefabs } from '../../../src/Editor/Plugins/pluginsApi'

function answer(status: number, body: unknown, contentType = 'application/json') {
  return vi.fn(async () => new Response(typeof body === 'string' ? body : JSON.stringify(body), { status, headers: { 'content-type': contentType } }))
}

const plugin = (overrides: Partial<PluginInfo> = {}): PluginInfo => ({ package: 'forest', enabled: true, installed: true, declaredPrefabs: [], usedPrefabs: [], ...overrides })

describe('pluginsApi', () => {
  it('asks the dev server for the project\'s plugins', async () => {
    const fetchFn = answer(200, { root: '/project', plugins: [plugin()] })

    expect(await fetchPlugins(fetchFn)).toEqual({ root: '/project', plugins: [plugin()] })
    expect(fetchFn).toHaveBeenCalledWith('/__mavonengine/plugins')
  })

  it('explains what is wrong when there is no list', async () => {
    await expect(fetchPlugins(vi.fn(async () => {
      throw new TypeError('Failed to fetch')
    }))).rejects.toThrow('not reachable')
    // A dev server without the Vite plugin answers with the game's page
    await expect(fetchPlugins(answer(200, '<html></html>', 'text/html'))).rejects.toThrow('mavonEnginePlugins()')
    await expect(fetchPlugins(answer(403, { error: 'no' }))).rejects.toThrow('localhost')
    await expect(fetchPlugins(answer(500, { error: 'no' }))).rejects.toThrow('500')
  })

  it('takes an answer without plugins as none', async () => {
    expect(await fetchPlugins(answer(200, {}))).toEqual({ root: null, plugins: [] })
  })

  it('lists the prefabs a plugin registered, declares or the project uses', () => {
    const prefabs = pluginPrefabs(plugin({ declaredPrefabs: ['Tree', 'Rock'], usedPrefabs: ['Tree', 'Bush'] }), [
      { name: 'Tree', label: 'Pine tree', plugin: 'forest' },
      { name: 'Fern', plugin: 'forest' },
      { name: 'Tree', plugin: 'other' },
      { name: 'Box' },
    ])

    expect(prefabs).toEqual([
      { name: 'Tree', label: 'Pine tree', registered: true, used: true },
      { name: 'Fern', label: undefined, registered: true, used: false },
      { name: 'Rock', registered: false, used: false },
      { name: 'Bush', registered: false, used: true },
    ])
  })
})
