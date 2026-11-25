import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import type GameServerClient from './GameServerClient'
import { z } from 'zod'
import { READ_ONLY, run } from './result'

/**
 * Columns whose values aren't handed to the assistant: password hashes, token hashes, keys. Whatever a tool returns
 * goes to the assistant's model, and a hash is enough to try passwords against offline
 */
const SECRET_COLUMN_RE = /secret|password|passwd|token|hash|salt|api_?key|private/i

/** Most rows one call returns: the server's own limit too */
const MAX_ROWS = 500

interface Column { name: string, [key: string]: unknown }
interface Table { name: string, plugin?: string | null, rows?: number | null, columns?: Column[] }

/** A page of rows with the values of secret columns replaced, and which columns those were */
export function redactRows(columns: Column[], rows: Record<string, unknown>[]) {
  const secret = new Set(columns.map(column => column.name).filter(name => SECRET_COLUMN_RE.test(name)))
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (SECRET_COLUMN_RE.test(key))
        secret.add(key)
    }
  }

  return {
    redacted: [...secret],
    rows: secret.size === 0
      ? rows
      : rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [
          key,
          secret.has(key) && value !== null
            ? '[redacted]'
            : value,
        ]))),
  }
}

/**
 * database_overview and database_rows: what the project's database plugin, such as @mavonengine/sqlite, holds.
 * They only read, through the server's own GET /api/game/database endpoints, so they work on any database plugin
 */
export function registerDatabaseTools(server: McpServer, client: GameServerClient) {
  server.registerTool('database_overview', {
    title: 'Database tables',
    description: 'The game server\'s database, from the project\'s database plugin (e.g. @mavonengine/sqlite): which plugin '
      + 'gives it, every table with the plugin it belongs to (by its table prefix, "game" for the game\'s own), its columns and '
      + 'row count, and the migrations each plugin ran. Use database_rows to read a table. Needs the server\'s admin token '
      + '(--token) unless the server runs on this machine without one.',
    inputSchema: {
      table: z.string().optional().describe('Only tables whose name contains this, case-insensitive'),
    },
    annotations: READ_ONLY,
  }, ({ table }) => run(async () => {
    const overview = await client.database() as { provider: string | null, tables?: Table[], migrations?: unknown[] }
    if (!overview.provider) {
      return {
        provider: null,
        tables: [],
        note: 'The project has no database plugin. Install one, e.g. `npx @mavonengine/cli install @mavonengine/sqlite`, '
          + 'and plugins get ctx.db and their migrations run',
      }
    }

    const needle = table?.toLowerCase()
    const tables = (overview.tables ?? []).filter(t => !needle || t.name.toLowerCase().includes(needle))
    return { provider: overview.provider, tables, migrations: overview.migrations ?? [] }
  }))

  server.registerTool('database_rows', {
    title: 'Rows of a database table',
    description: 'A page of rows of one table of the game server\'s database, as database_overview lists them, with the total '
      + 'row count. Values of columns that look secret (password and token hashes, keys) are replaced with "[redacted]" and listed in `redacted`. '
      + 'Page with offset and limit.',
    inputSchema: {
      table: z.string().min(1).describe('Table name, e.g. chat_mutes'),
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().min(1).max(MAX_ROWS).default(50),
    },
    annotations: READ_ONLY,
  }, ({ table, offset, limit }) => run(async () => {
    const page = await client.tableRows(table, offset, limit) as { table: string, columns?: Column[], rows?: Record<string, unknown>[], total: number, offset: number, limit: number }
    const { rows, redacted } = redactRows(page.columns ?? [], page.rows ?? [])
    return {
      table: page.table,
      total: page.total,
      offset: page.offset,
      limit: page.limit,
      columns: page.columns ?? [],
      ...(redacted.length
        ? { redacted }
        : {}),
      rows,
    }
  }))
}
