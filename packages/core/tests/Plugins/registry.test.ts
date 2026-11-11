import { describe, expect, it, vi } from 'vitest'
import { fetchPluginReadme, fetchPluginRegistry, MAX_REMOTE_README_CHARS, notInProject, PLUGIN_REGISTRY_URL } from '../../src/Plugins/registry'

describe('plugin registry', () => {
  it('reads plugins.json from the main branch on GitHub, uncached', async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ version: 1, plugins: [{ package: 'forest', target: 'both' }, { name: 'no package' }] })))

    const registry = await fetchPluginRegistry({ fetch })

    expect(PLUGIN_REGISTRY_URL).toBe('https://raw.githubusercontent.com/MavonEngine/Core/main/plugins.json')
    expect(fetch).toHaveBeenCalledWith(PLUGIN_REGISTRY_URL, expect.objectContaining({ cache: 'no-store' }))
    expect(registry.plugins.map(plugin => [plugin.package, plugin.name, plugin.target])).toEqual([['forest', 'forest', 'both']])
  })

  it('leaves out the plugins a project already has', () => {
    const plugins = [{ package: 'forest', name: 'forest' }, { package: '@acme/chat', name: 'Chat' }]

    expect(notInProject(plugins, ['@acme/chat', 'unlisted'])).toEqual([plugins[0]])
    expect(notInProject(plugins, [])).toEqual(plugins)
  })

  it('reads the readme a plugin of the list points to', async () => {
    const fetch = vi.fn(async () => new Response('# Forest\n\nTrees.'))

    expect(await fetchPluginReadme({ package: 'forest', readme: 'https://example.com/README.md' }, { fetch })).toBe('# Forest\n\nTrees.')
    expect(fetch).toHaveBeenCalledWith('https://example.com/README.md', expect.objectContaining({ cache: 'no-store' }))
  })

  it('says why there is no readme', async () => {
    const fetch = vi.fn(async () => new Response('Not Found', { status: 404 }))

    await expect(fetchPluginReadme({ package: 'forest' }, { fetch })).rejects.toThrow('The list has no readme for forest')
    // Only the web: never a file or a script url from the list
    await expect(fetchPluginReadme({ package: 'forest', readme: 'file:///etc/passwd' }, { fetch })).rejects.toThrow('no readme')
    expect(fetch).not.toHaveBeenCalled()

    await expect(fetchPluginReadme({ package: 'forest', readme: 'https://example.com/README.md' }, { fetch })).rejects.toThrow('was not found')
    await expect(fetchPluginReadme({ package: 'forest', readme: 'https://example.com/README.md' }, { fetch: vi.fn(async () => {
      throw new Error('offline')
    }) })).rejects.toThrow(/Can't reach .*offline/)
  })

  it('cuts off a very long readme', async () => {
    const fetch = vi.fn(async () => new Response('x'.repeat(MAX_REMOTE_README_CHARS + 50)))

    const readme = await fetchPluginReadme({ package: 'forest', readme: 'https://example.com/README.md' }, { fetch })

    expect(readme.length).toBeLessThan(MAX_REMOTE_README_CHARS + 50)
    expect(readme).toContain('cut off')
  })
})
