import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

/** The documentation site's own MCP server, which `mavonengine mcp` passes the docs_* tools through to */
export const DEFAULT_DOCS_URL = 'https://mavonengine.com/mcp'

/** Name the game server's MCP server is registered under in the client's config */
export const MCP_SERVER_NAME = 'mavonengine'

/**
 * Project scoped MCP config in the project root. The `mcpServers` format is the common one:
 * Claude Code reads this file directly, other clients take the same entry in their own config file
 */
export const MCP_CONFIG_FILE = '.mcp.json'

/**
 * How an MCP client starts `mavonengine mcp`. The CLI isn't a project dependency, so it goes through npx
 */
export function mcpServerEntry() {
  return {
    command: 'npx',
    args: ['-y', '@mavonengine/cli', 'mcp'],
  }
}

/**
 * Add the mavonengine server to `<dir>/.mcp.json`, keeping any other servers in it.
 * An entry that is already there is left alone. Returns whether the file was written.
 */
export function writeMcpConfig(dir: string): boolean {
  const file = join(dir, MCP_CONFIG_FILE)

  let config: { mcpServers?: Record<string, unknown>, [key: string]: unknown } = {}
  if (existsSync(file)) {
    try {
      config = JSON.parse(readFileSync(file, 'utf8'))
    }
    catch {
      // Not ours to fix: leave a file we can't read untouched
      return false
    }
    if (!config || typeof config !== 'object' || Array.isArray(config))
      return false
  }

  const servers = config.mcpServers && typeof config.mcpServers === 'object' ? config.mcpServers : {}
  if (MCP_SERVER_NAME in servers)
    return false

  config.mcpServers = { ...servers, [MCP_SERVER_NAME]: mcpServerEntry() }
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`)
  return true
}
