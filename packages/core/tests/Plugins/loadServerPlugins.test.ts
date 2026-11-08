import { rmSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadServerPlugins } from '../../src/Plugins/loadServerPlugins'
import { installPlugin, tempProject, writeConfig } from './fixtures'

let root: string

beforeEach(() => {
  root = tempProject()
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe('loadServerPlugins', () => {
  it('imports the server entries of enabled plugins', async () => {
    installPlugin(root, 'chat', { target: 'server', server: './server.js' }, { 'server.js': 'export default { name: "Chat", tick() {} }' })
    writeConfig(root, { plugins: { chat: { options: { max: 3 } } } })

    const { plugins, warnings } = await loadServerPlugins(root)

    expect(warnings).toEqual([])
    expect(plugins).toHaveLength(1)
    expect(plugins[0].package).toBe('chat')
    expect(plugins[0].options).toEqual({ max: 3 })
    expect(plugins[0].plugin.name).toBe('Chat')
  })

  it('skips client-only plugins', async () => {
    installPlugin(root, 'hud', { target: 'client', client: './client.js' }, { 'client.js': 'export default {}' })
    writeConfig(root, { plugins: { hud: {} } })

    expect(await loadServerPlugins(root)).toEqual({ plugins: [], warnings: [] })
  })

  it('reports entries without a default export or that fail to import', async () => {
    installPlugin(root, 'nodefault', { target: 'server', server: './server.js' }, { 'server.js': 'export const x = 1' })
    installPlugin(root, 'throws', { target: 'server', server: './server.js' }, { 'server.js': 'throw new Error("bad plugin")' })
    writeConfig(root, { plugins: { nodefault: {}, throws: {} } })

    const { plugins, warnings } = await loadServerPlugins(root)

    expect(plugins).toEqual([])
    expect(warnings).toEqual([
      'nodefault: server entry has no default export',
      'throws: could not load its server entry: bad plugin',
    ])
  })
})
