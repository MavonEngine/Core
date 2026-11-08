import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { parseMcpArgs } from '../src/commands/mcp'
import { DEFAULT_DOCS_URL, DocsClient } from '../src/mcp/docs'
import GameServerClient from '../src/mcp/GameServerClient'
import { createMcpServer } from '../src/mcp/server'

const pages = [{ path: '/networking/state-sync', title: 'State Sync' }]

/** Stands in for the docs site's MCP server: the same two tools mavonengine.com/mcp has */
async function fakeDocsSite(): Promise<Client> {
  const site = new McpServer({ name: 'MavonEngine docs', version: '1.0.0' })
  site.registerTool('list-pages', {}, () => ({ content: [{ type: 'text', text: JSON.stringify(pages) }] }))
  site.registerTool('get-page', { inputSchema: { path: z.string() } }, ({ path }) => path === '/networking/state-sync'
    ? { content: [{ type: 'text', text: '# State Sync\n\nHow entity state is broadcast.' }] }
    : { isError: true, content: [{ type: 'text', text: `Page not found: ${path}` }] })

  const client = new Client({ name: 'test', version: '0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([site.connect(a), client.connect(b)])
  return client
}

async function connect(docs?: DocsClient) {
  const server = createMcpServer(new GameServerClient({ url: 'http://localhost:8050', fetch: (async () => new Response('', { status: 404 })) as any }), docs)
  const client = new Client({ name: 'test', version: '0' })
  const [a, b] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(a), client.connect(b)])
  return client
}

describe('docs tools', () => {
  it('pass the docs site\'s answers through', async () => {
    const client = await connect(new DocsClient(DEFAULT_DOCS_URL, fakeDocsSite))

    const list = await client.callTool({ name: 'docs_list_pages', arguments: {} }) as any
    expect(JSON.parse(list.content[0].text)).toEqual(pages)

    const page = await client.callTool({ name: 'docs_get_page', arguments: { path: '/networking/state-sync' } }) as any
    expect(page.content[0].text).toContain('# State Sync')

    const missing = await client.callTool({ name: 'docs_get_page', arguments: { path: '/nope' } }) as any
    expect(missing.isError).toBe(true)
    expect(missing.content[0].text).toBe('Page not found: /nope')
  })

  it('connect only when a docs tool is used, once', async () => {
    const connectDocs = vi.fn(fakeDocsSite)
    const client = await connect(new DocsClient(DEFAULT_DOCS_URL, connectDocs))

    await client.listTools()
    expect(connectDocs).not.toHaveBeenCalled()

    await client.callTool({ name: 'docs_list_pages', arguments: {} })
    await client.callTool({ name: 'docs_list_pages', arguments: {} })
    expect(connectDocs).toHaveBeenCalledTimes(1)
  })

  it('report an unreachable site and connect again next time', async () => {
    const connectDocs = vi.fn()
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockImplementation(fakeDocsSite)
    const client = await connect(new DocsClient('https://docs.example.com/mcp', connectDocs))

    const failed = await client.callTool({ name: 'docs_list_pages', arguments: {} }) as any
    expect(failed.isError).toBe(true)
    expect(failed.content[0].text).toBe('Could not read the MavonEngine docs at https://docs.example.com/mcp: fetch failed')

    const retried = await client.callTool({ name: 'docs_list_pages', arguments: {} }) as any
    expect(retried.isError).toBeUndefined()
    expect(connectDocs).toHaveBeenCalledTimes(2)
  })

  it('are left out without a docs client', async () => {
    const { tools } = await (await connect()).listTools()
    expect(tools.some(tool => tool.name.startsWith('docs_'))).toBe(false)

    const withDocs = await (await connect(new DocsClient(DEFAULT_DOCS_URL, fakeDocsSite))).listTools()
    expect(withDocs.tools.filter(tool => tool.name.startsWith('docs_')).map(tool => tool.name)).toEqual(['docs_list_pages', 'docs_get_page'])
    expect(withDocs.tools.find(tool => tool.name === 'docs_get_page')!.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true })
  })
})

describe('parseMcpArgs docs options', () => {
  it('uses mavonengine.com by default, --docs-url to change it and --no-docs to leave the tools out', () => {
    expect(parseMcpArgs([], {})).toMatchObject({ docsUrl: 'https://mavonengine.com/mcp' })
    expect(parseMcpArgs(['--docs-url', 'http://localhost:3000/mcp'], {})).toMatchObject({ docsUrl: 'http://localhost:3000/mcp' })
    expect(parseMcpArgs(['--no-docs'], {})).toMatchObject({ docsUrl: false })
    expect(() => parseMcpArgs(['--docs-url', 'nope'], {})).toThrow('Invalid --docs-url')
  })
})
