import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { z } from 'zod'
import { version } from '../../package.json'
import { DEFAULT_DOCS_URL } from './config'

import { READ_ONLY } from './result'

export { DEFAULT_DOCS_URL }

const REQUEST_TIMEOUT_MS = 15000

/**
 * Asks the documentation site's own MCP server. Connects on first use, so the other tools work offline,
 * and connects again after a failure.
 */
export class DocsClient {
  private client?: Promise<Client>

  constructor(
    readonly url: string = DEFAULT_DOCS_URL,
    /** How to reach the docs server, replaceable in tests */
    private connect: (url: string) => Promise<Client> = connectHttp,
  ) { }

  async call(tool: string, args: Record<string, unknown> = {}): Promise<CallToolResult> {
    this.client ??= this.connect(this.url)

    try {
      const client = await this.client
      return await client.callTool({ name: tool, arguments: args }, undefined, { timeout: REQUEST_TIMEOUT_MS }) as CallToolResult
    }
    catch (err) {
      // Next call starts over, e.g. once the network is back
      const failed = this.client
      this.client = undefined
      void failed.then(client => client.close()).catch(() => {})
      throw new Error(`Could not read the MavonEngine docs at ${this.url}: ${(err as Error).message}`)
    }
  }

  async close() {
    const client = this.client
    this.client = undefined
    await client?.then(c => c.close()).catch(() => {})
  }
}

async function connectHttp(url: string): Promise<Client> {
  // Loaded on first use, only the docs tools need the HTTP client
  const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js')
  const client = new Client({ name: 'mavonengine-cli', version })
  await client.connect(new StreamableHTTPClientTransport(new URL(url)))
  return client
}

/**
 * docs_list_pages and docs_get_page, passed through to the documentation site's MCP server unchanged
 */
export function registerDocsTools(server: McpServer, docs: DocsClient) {
  const forward = async (tool: string, args?: Record<string, unknown>): Promise<CallToolResult> => {
    try {
      return await docs.call(tool, args)
    }
    catch (err) {
      return { isError: true, content: [{ type: 'text', text: (err as Error).message }] }
    }
  }

  server.registerTool('docs_list_pages', {
    title: 'List MavonEngine docs pages',
    description: 'Every page of the MavonEngine documentation (mavonengine.com) with its path, title, description and category. '
      + 'Use it to find the page about an engine concept or API, then read it with docs_get_page.',
    annotations: { ...READ_ONLY, openWorldHint: true },
  }, () => forward('list-pages'))

  server.registerTool('docs_get_page', {
    title: 'Read a MavonEngine docs page',
    description: 'One page of the MavonEngine documentation as Markdown, by its path from docs_list_pages (e.g. /networking/state-sync).',
    inputSchema: { path: z.string().min(1).describe('Page path, e.g. /getting-started/installation') },
    annotations: { ...READ_ONLY, openWorldHint: true },
  }, ({ path }) => forward('get-page', { path }))
}
