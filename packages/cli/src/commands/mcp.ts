import process from 'node:process'
import { parseArgs } from 'node:util'
import GameServerClient from '../mcp/GameServerClient'
import { UsageError } from './dashboard'

export const MCP_HELP = `Usage: mavonengine mcp [options]

Model Context Protocol (MCP) server over stdio, for any MCP client and model
(Claude Code, Cursor, VS Code, Codex, Gemini CLI, Zed, local models, …).
It lets the assistant read a running game: the game server (status, metrics,
players, scene, entities, logs, HTTP requests) and the game tabs open in a
browser (renderer stats, entities, network, console, screenshots), and compare
an entity on both sides. Every tool is read-only. Server scene and entity tools
need the game server in development (NODE_ENV is not "production"); client
tools need the client served by Vite in dev.

Register it in your client as a stdio server with this command:
  npx -y @mavonengine/cli mcp [options]

Most clients take JSON like this (projects from 'mavonengine create' get it in .mcp.json):
  { "mcpServers": { "mavonengine": { "command": "npx", "args": ["-y", "@mavonengine/cli", "mcp"] } } }

Options:
  --host <host>        Server host (default: localhost)
  --port <port>        Server HTTP port (default: 8050)
  --url <url>          Server base URL, e.g. http://localhost:8050, overrides --host and --port
  --client-url <url>   Where Vite serves the client in dev (default: the server URL,
                       which serves it in the template), e.g. http://localhost:5173
  --token <token>      Metrics token (or set MAVONENGINE_METRICS_TOKEN)
  -h, --help           Show this help
`

export interface McpOptions {
  client: GameServerClient
}

export function parseMcpArgs(args: string[], env: Record<string, string | undefined> = process.env): McpOptions | 'help' {
  const { values } = parseArgs({
    args,
    options: {
      'host': { type: 'string', default: 'localhost' },
      'port': { type: 'string', default: '8050' },
      'url': { type: 'string' },
      'client-url': { type: 'string' },
      'token': { type: 'string' },
      'help': { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  })

  if (values.help)
    return 'help'

  let url = values.url
  if (!url) {
    const port = Number(values.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new UsageError('--port must be between 1 and 65535')

    const host = values.host!.includes(':') && !values.host!.startsWith('[') ? `[${values.host}]` : values.host
    url = `http://${host}:${port}`
  }

  for (const [flag, value] of [['--url', url], ['--client-url', values['client-url']]] as const) {
    try {
      if (value !== undefined)
        void new URL(value)
    }
    catch {
      throw new UsageError(`Invalid ${flag}: ${value}`)
    }
  }

  return { client: new GameServerClient({ url, clientUrl: values['client-url'], token: values.token ?? env.MAVONENGINE_METRICS_TOKEN }) }
}

/**
 * Serve MCP on stdin / stdout until the client disconnects. stdout carries the protocol, so nothing else may write to it.
 */
export async function runMcpCommand({ client }: McpOptions): Promise<number> {
  // Loaded lazily so the other commands don't pay for the MCP SDK
  const [{ StdioServerTransport }, { createMcpServer }] = await Promise.all([
    import('@modelcontextprotocol/sdk/server/stdio.js'),
    import('../mcp/server'),
  ])

  const server = createMcpServer(client)
  const transport = new StdioServerTransport()

  const closed = new Promise<void>((resolve) => {
    transport.onclose = resolve
    process.stdin.on('end', resolve)
  })

  await server.connect(transport)
  process.stderr.write(`mavonengine mcp: reading the game server at ${client.url}\n`)

  await closed
  await server.close().catch(() => {})
  return 0
}
