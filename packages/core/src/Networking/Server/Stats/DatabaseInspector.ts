import type { Kysely } from 'kysely'
import { tablePrefix } from '../../../Plugins/Database/tables'

/** What the inspector reads: the server's database, which plugin gave it, and the plugins that may own tables */
export interface DatabaseSource {
  readonly db: Kysely<any> | undefined
  readonly databaseProvider: string | undefined
  /** Packages of the project's plugins, to tell whose a table is */
  databasePlugins(): string[]
}

export interface DatabaseColumn {
  name: string
  type: string
  nullable: boolean
  autoIncrement: boolean
  hasDefault: boolean
}

export interface DatabaseTable {
  name: string
  /** Package of the plugin the table belongs to by its prefix, null for the game's own and unknown ones */
  plugin: string | null
  /** Null when they could not be counted */
  rows: number | null
  columns: DatabaseColumn[]
}

export interface DatabaseMigrations {
  /** Package of the plugin, null when no plugin of the project has the table's prefix (any more) */
  plugin: string | null
  /** The table they are recorded in, `<prefix>__migrations` */
  table: string
  applied: { name: string, executedAt: string | null }[]
}

export interface DatabaseOverview {
  /** Package of the database plugin, null without one */
  provider: string | null
  /** The tables apart from the engine's migration records, by name */
  tables: DatabaseTable[]
  migrations: DatabaseMigrations[]
}

export interface DatabaseTablePage {
  table: string
  columns: DatabaseColumn[]
  rows: Record<string, unknown>[]
  /** Rows in the whole table */
  total: number
  offset: number
  limit: number
}

export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 500
/** Longer text is cut off, so a big blob of JSON in one cell can't make a page huge */
export const MAX_VALUE_CHARS = 2000

const MIGRATIONS_SUFFIX = '__migrations'

/**
 * Reads the server's database for GET /api/game/database: its tables, whose they are and what is in them.
 * Only reads, and only through Kysely's query builder, so it works on any database a plugin gives.
 */
export default class DatabaseInspector {
  constructor(private source: DatabaseSource) {}

  async overview(): Promise<DatabaseOverview> {
    const { db, databaseProvider } = this.source
    if (!db)
      return { provider: null, tables: [], migrations: [] }

    const owners = this.owners()
    const all = (await db.introspection.getTables()).filter(table => !table.isView)
    const tables: DatabaseTable[] = []
    const migrations: DatabaseMigrations[] = []

    for (const table of all) {
      if (table.name.endsWith(MIGRATIONS_SUFFIX)) {
        const prefix = table.name.slice(0, -MIGRATIONS_SUFFIX.length)
        migrations.push({
          plugin: owners.find(owner => owner.prefix === prefix)?.package ?? null,
          table: table.name,
          applied: await this.applied(db, table.name),
        })
        continue
      }

      tables.push({
        name: table.name,
        plugin: ownerOf(table.name, owners),
        rows: await count(db, table.name),
        columns: table.columns.map(column),
      })
    }

    tables.sort((a, b) => a.name.localeCompare(b.name))
    migrations.sort((a, b) => a.table.localeCompare(b.table))
    return { provider: databaseProvider ?? null, tables, migrations }
  }

  /**
   * A page of a table's rows, undefined when the database has no such table. The name is checked against the
   * database's own list of tables, so nothing a request sends ends up in SQL.
   */
  async page(name: string, offset = 0, limit = DEFAULT_PAGE_SIZE): Promise<DatabaseTablePage | undefined> {
    const { db } = this.source
    if (!db)
      return undefined

    const table = (await db.introspection.getTables()).find(t => t.name === name)
    if (!table)
      return undefined

    const start = Math.max(0, Math.floor(offset) || 0)
    const size = Math.min(MAX_PAGE_SIZE, Math.max(1, Math.floor(limit) || DEFAULT_PAGE_SIZE))
    const rows = await db.selectFrom(table.name).selectAll().limit(size).offset(start).execute()

    return {
      table: table.name,
      columns: table.columns.map(column),
      rows: rows.map(row => Object.fromEntries(Object.entries(row).map(([key, value]) => [
        key,
        jsonValue(value),
      ]))),
      total: (await count(db, table.name)) ?? rows.length,
      offset: start,
      limit: size,
    }
  }

  /** The prefixes of the project's plugins, longest first, so `acme_chat_x` goes to `@acme/chat` rather than `acme` */
  private owners() {
    const owners: { package: string, prefix: string }[] = []
    for (const pkg of new Set(this.source.databasePlugins())) {
      try {
        owners.push({
          package: pkg,
          prefix: tablePrefix(pkg),
        })
      }
      catch {
        // A package name that gives no prefix has no tables
      }
    }
    return owners.sort((a, b) => b.prefix.length - a.prefix.length)
  }

  private async applied(db: Kysely<any>, table: string) {
    try {
      const rows = await db.selectFrom(table).selectAll().orderBy('name').execute()
      return rows.map(row => ({
        name: String(row.name),
        executedAt: typeof row.executed_at === 'string'
          ? row.executed_at
          : null,
      }))
    }
    catch {
      // Named like the engine's, but not one of them
      return []
    }
  }
}

function ownerOf(table: string, owners: { package: string, prefix: string }[]): string | null {
  return owners.find(owner => table.startsWith(`${owner.prefix}_`))?.package ?? null
}

async function count(db: Kysely<any>, table: string): Promise<number | null> {
  try {
    const row = await db.selectFrom(table).select(eb => eb.fn.countAll().as('n')).executeTakeFirst()
    // Postgres counts in bigint, which its driver gives as a string
    const n = Number(row?.n)
    return Number.isFinite(n)
      ? n
      : null
  }
  catch {
    return null
  }
}

function column(c: { name: string, dataType: string, isNullable: boolean, isAutoIncrementing: boolean, hasDefaultValue: boolean }): DatabaseColumn {
  return {
    name: c.name,
    type: c.dataType,
    nullable: c.isNullable,
    autoIncrement: c.isAutoIncrementing,
    hasDefault: c.hasDefaultValue,
  }
}

/** A value as JSON can carry it */
export function jsonValue(value: unknown): unknown {
  if (typeof value === 'bigint') {
    return Number.isSafeInteger(Number(value))
      ? Number(value)
      : value.toString()
  }
  if (value instanceof Date)
    return value.toISOString()
  if (value instanceof Uint8Array)
    return `<${value.byteLength} bytes>`
  if (typeof value === 'string' && value.length > MAX_VALUE_CHARS)
    return `${value.slice(0, MAX_VALUE_CHARS)}…`
  return value
}
