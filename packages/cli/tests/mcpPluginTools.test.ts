import type { PluginToolInfo } from '@mavonengine/core/Plugins/types'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { describe, expect, it } from 'vitest'
import { parseMcpArgs } from '../src/commands/mcp'
import GameServerClient from '../src/mcp/GameServerClient'
import { ProjectPluginTools } from '../src/mcp/projectPluginTools'
import { createMcpServer } from '../src/mcp/server'

const importTool: PluginToolInfo = {
  name: 'kenney_import',
  plugin: '@mavonengine/kenney',
  title: 'Import files of a pack',
  description: 'Copies files of a downloaded pack into the project',
  input: {
    type: 'object',
    properties: {
      slug: { type: 'string' },
      files: {
        type: 'array',
        items: { type: 'string' },
      },
    },
    required: ['slug', 'files'],
  },
  readOnly: false,
  destructive: false,
  openWorld: false,
}

const searchTool: PluginToolInfo = {
  name: 'kenney_search_packs',
  plugin: '@mavonengine/kenney',
  description: 'Finds packs',
  input: {
    type: 'object',
    properties: {
      query: { type: 'string' },
    },
  },
  readOnly: true,
  destructive: false,
  openWorld: false,
}

/** A client dev server that lists `tools` and records the calls */
function devServer(tools: { list: PluginToolInfo[] | null }) {
  const calls: { name: string, args: unknown }[] = []
  const fetch = (async (input: URL, init?: RequestInit) => {
    const url = new URL(input)
    if (url.pathname === '/__mavonengine/mcp/tools' && tools.list)
      return Response.json({ tools: tools.list })
    if (url.pathname.startsWith('/__mavonengine/mcp/tools/') && init?.method === 'POST') {
      const name = decodeURIComponent(url.pathname.split('/').pop()!)
      const { arguments: args } = JSON.parse(String(init.body))
      calls.push({ name, args })
      return name === 'kenney_import' && args.slug === 'nope'
        ? Response.json({ error: 'No pack nope in the catalog' })
        : Response.json({
            result: { ok: true, name },
          })
    }
    return new Response('<html></html>', {
      status: 200,
      headers: { 'Content-Type': 'text/html' },
    })
  }) as unknown as typeof globalThis.fetch
  return { fetch, calls }
}

async function connect(tools: { list: PluginToolInfo[] | null }, options: { readOnly?: boolean } = {}) {
  const dev = devServer(tools)
  const gameClient = new GameServerClient({ url: 'http://localhost:8050', fetch: dev.fetch })
  const server = createMcpServer(gameClient)
  const warnings: string[] = []
  const pluginTools = new ProjectPluginTools(server, gameClient, {
    ...options,
    warn: message => warnings.push(message),
  })
  await pluginTools.refresh()

  const client = new Client({ name: 'test', version: '0' })
  let listChanged = 0
  client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
    listChanged++
  })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([
    server.connect(a),
    client.connect(b),
  ])

  const toolNames = async () => (await client.listTools()).tools.map(tool => tool.name).filter(name => name.startsWith('kenney_') || name === 'server_status')
  return {
    client,
    pluginTools,
    dev,
    warnings,
    toolNames,
    listChanged: () => listChanged,
  }
}

describe('plugin tools in mavonengine mcp', () => {
  it('lists the dev entries\' tools with their schema and what they change', async () => {
    const { client } = await connect({
      list: [importTool, searchTool],
    })
    const { tools } = await client.listTools()
    const listed = tools.find(tool => tool.name === 'kenney_import')!

    expect(listed.title).toBe('Import files of a pack')
    expect(listed.description).toContain('From the plugin @mavonengine/kenney')
    expect(listed.inputSchema).toMatchObject({
      type: 'object',
      properties: {
        slug: { type: 'string' },
        files: { type: 'array' },
      },
      required: ['slug', 'files'],
    })
    expect(listed.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false })
    expect(tools.find(tool => tool.name === 'kenney_search_packs')!.annotations).toMatchObject({ readOnlyHint: true })
  })

  it('runs a tool on the dev server and passes its result or error on', async () => {
    const { client, dev } = await connect({
      list: [importTool],
    })

    const ok = await client.callTool({
      name: 'kenney_import',
      arguments: {
        slug: 'mini-forest',
        files: ['tree.glb'],
      },
    }) as any
    expect(JSON.parse(ok.content[0].text)).toEqual({ ok: true, name: 'kenney_import' })
    expect(dev.calls).toEqual([
      {
        name: 'kenney_import',
        args: {
          slug: 'mini-forest',
          files: ['tree.glb'],
        },
      },
    ])

    const failed = await client.callTool({
      name: 'kenney_import',
      arguments: { slug: 'nope', files: [] },
    }) as any
    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toBe('No pack nope in the catalog')
  })

  it('checks the arguments against the tool\'s schema before asking the dev server', async () => {
    const { client, dev } = await connect({
      list: [importTool],
    })

    const result = await client.callTool({
      name: 'kenney_import',
      arguments: { slug: 'mini-forest' },
    }) as any
    expect(result.isError).toBe(true)
    expect(dev.calls).toEqual([])
  })

  it('leaves out the tools that change something with --read-only', async () => {
    const { toolNames } = await connect({
      list: [importTool, searchTool],
    }, { readOnly: true })

    expect(await toolNames()).toEqual(['server_status', 'kenney_search_packs'])
    expect(parseMcpArgs(['--read-only'])).toMatchObject({ readOnly: true })
    expect(parseMcpArgs([])).toMatchObject({ readOnly: false })
  })

  it('keeps its own tools when a plugin uses one of their names', async () => {
    const { toolNames, warnings, pluginTools } = await connect({
      list: [
        { ...searchTool, name: 'server_status' },
      ],
    })

    expect(await toolNames()).toEqual(['server_status'])
    await pluginTools.refresh()
    expect(warnings).toHaveLength(1)
    expect(warnings[0]).toContain('tool server_status left out')
  })

  it('follows the dev server: tools appear, change and go, and the client is told', async () => {
    const tools: { list: PluginToolInfo[] | null } = { list: null }
    const { pluginTools, toolNames, listChanged } = await connect(tools)
    expect(await toolNames()).toEqual(['server_status'])

    tools.list = [searchTool]
    await pluginTools.refresh()
    expect(await toolNames()).toEqual(['server_status', 'kenney_search_packs'])

    tools.list = [
      { ...searchTool, description: 'Finds packs by tag' },
      importTool,
    ]
    await pluginTools.refresh()
    expect(await toolNames()).toEqual(['server_status', 'kenney_search_packs', 'kenney_import'])

    tools.list = [importTool]
    await pluginTools.refresh()
    expect(await toolNames()).toEqual(['server_status', 'kenney_import'])

    // The dev server stopped: its tools stay listed, and say it isn't reachable when called
    tools.list = null
    await pluginTools.refresh()
    expect(await toolNames()).toEqual(['server_status', 'kenney_import'])
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(listChanged()).toBeGreaterThan(0)
  })
})
