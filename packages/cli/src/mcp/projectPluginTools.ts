import type { PluginToolInfo } from '@mavonengine/core/Plugins/types'
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js'
import type GameServerClient from './GameServerClient'
import { z } from 'zod'
import { READ_ONLY, run } from './result'

export interface ProjectPluginToolsOptions {
  /** Leave out the tools that change something */
  readOnly?: boolean
  /** Where to say what was left out */
  warn?(message: string): void
}

/** The tool's arguments as zod, which the SDK lists as JSON Schema and checks calls against. Anything goes if it can't be read */
function inputSchema(input: PluginToolInfo['input']) {
  try {
    const schema = z.fromJSONSchema(input as Parameters<typeof z.fromJSONSchema>[0])
    if (schema instanceof z.ZodObject)
      return schema
  }
  catch {}
  return z.object({}).loose()
}

function annotations(tool: PluginToolInfo) {
  return tool.readOnly
    ? { ...READ_ONLY, openWorldHint: tool.openWorld }
    : {
        readOnlyHint: false,
        destructiveHint: tool.destructive,
        idempotentHint: false,
        openWorldHint: tool.openWorld,
      }
}

/**
 * The tools of the project's plugins, from their dev entries on the client's dev server, as MCP tools. `refresh()`
 * asks the dev server again and adds, changes and removes tools to match; the SDK tells the client the list changed.
 */
export class ProjectPluginTools {
  private registered = new Map<string, { tool: RegisteredTool, signature: string }>()
  /** Tools left out already said so, they would be on every refresh */
  private warned = new Set<string>()

  constructor(
    private server: McpServer,
    private client: GameServerClient,
    private options: ProjectPluginToolsOptions = {},
  ) { }

  /** The names of the plugin tools offered now */
  get names(): string[] {
    return [
      ...this.registered.keys(),
    ]
  }

  async refresh(): Promise<void> {
    const listed = await this.client.pluginTools()
    // The dev server isn't running (yet): keep what there is, it is asked again later
    if (!listed)
      return

    const wanted = new Map<string, PluginToolInfo>()
    for (const tool of listed) {
      if (this.options.readOnly && !tool.readOnly)
        continue
      wanted.set(tool.name, tool)
    }

    for (const [name, { tool, signature }] of this.registered) {
      if (wanted.get(name) && JSON.stringify(wanted.get(name)) === signature)
        continue
      tool.remove()
      this.registered.delete(name)
    }

    for (const [name, info] of wanted) {
      if (this.registered.has(name))
        continue
      let tool: RegisteredTool
      try {
        tool = this.server.registerTool(name, {
          title: info.title,
          description: `${info.description}\n\nFrom the plugin ${info.plugin}, through the client's dev server.`,
          inputSchema: inputSchema(info.input),
          annotations: annotations(info),
        }, args => run(() => this.client.callPluginTool(name, args as Record<string, unknown>)))
      }
      catch (err) {
        // A name mavonengine mcp has a tool of its own by
        if (!this.warned.has(name))
          this.options.warn?.(`${info.plugin}: tool ${name} left out: ${(err as Error).message}`)
        this.warned.add(name)
        continue
      }
      this.registered.set(name, {
        tool,
        signature: JSON.stringify(info),
      })
    }
  }

  /** Ask again every `intervalMs`, so plugin tools come and go with the dev server. Returns a function that stops it */
  watch(intervalMs = 5000): () => void {
    const timer = setInterval(() => void this.refresh().catch(() => {}), intervalMs)
    timer.unref?.()
    return () => clearInterval(timer)
  }
}
