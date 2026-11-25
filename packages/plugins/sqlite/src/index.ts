import type { ServerPlugin, ServerPluginContext } from '@mavonengine/core/Plugins/types'
import type { Dialect, SqliteDatabase } from 'kysely'
import { mkdirSync } from 'node:fs'
import { dirname, isAbsolute, resolve } from 'node:path'
import process from 'node:process'
import { DatabaseSync } from 'node:sqlite'
import { Kysely, SqliteDialect } from 'kysely'

export interface SqliteOptions {
  /**
   * The database file, relative to the project root, or `:memory:` for a database that is gone when the server stops.
   * `MAVONENGINE_SQLITE_PATH` overrides it, e.g. to put it on a volume in production. Default `.mavonengine/data/mavonengine.sqlite`
   */
  path?: string
  /** How long a query waits for another connection's lock before it fails, in ms. Default 5000 */
  busyTimeoutMs?: number
}

export const PATH_ENV = 'MAVONENGINE_SQLITE_PATH'
export const DEFAULT_PATH = '.mavonengine/data/mavonengine.sqlite'
export const MEMORY = ':memory:'

type Value = null | number | bigint | string | NodeJS.ArrayBufferView

/**
 * What node:sqlite can't store, made storable: booleans as 1 and 0, dates as ISO strings, undefined as null.
 * What is read back is what SQLite has, so a boolean column reads as 0 or 1.
 */
function bindable(value: unknown): Value {
  if (typeof value === 'boolean')
    return value ? 1 : 0
  if (value instanceof Date)
    return value.toISOString()
  if (value === undefined)
    return null
  return value as Value
}

/**
 * node:sqlite in the shape Kysely's SqliteDialect expects, which is better-sqlite3's: parameters as an array,
 * and whether a statement returns rows.
 */
export function adaptDatabase(db: DatabaseSync): SqliteDatabase {
  return {
    close: () => db.close(),
    prepare(sql) {
      const statement = db.prepare(sql)
      const params = (parameters: ReadonlyArray<unknown>) => parameters.map(bindable)
      return {
        reader: statement.columns().length > 0,
        all: parameters => statement.all(...params(parameters)),
        run: parameters => statement.run(...params(parameters)),
        iterate: parameters => statement.iterate(...params(parameters)),
      }
    },
  }
}

/** A Kysely dialect on a node:sqlite database */
export function sqliteDialect(db: DatabaseSync): Dialect {
  return new SqliteDialect({
    database: adaptDatabase(db),
  })
}

/**
 * Open a SQLite database file for Kysely, creating it and its directory when they don't exist yet.
 * Also for scripts and tests outside of a game server.
 */
export function openSqlite(path: string, { busyTimeoutMs = 5000 }: Pick<SqliteOptions, 'busyTimeoutMs'> = {}): Kysely<any> {
  if (path !== MEMORY)
    mkdirSync(dirname(path), { recursive: true })

  const db = new DatabaseSync(path)
  db.exec(`PRAGMA busy_timeout = ${Math.max(0, Math.floor(busyTimeoutMs))}`)
  db.exec('PRAGMA foreign_keys = ON')
  if (path !== MEMORY) {
    // Readers don't block the writer and the other way round, and fewer fsyncs; still safe against crashes
    db.exec('PRAGMA journal_mode = WAL')
    db.exec('PRAGMA synchronous = NORMAL')
  }

  return new Kysely({
    dialect: sqliteDialect(db),
  })
}

/** The database file a server uses: the option or the environment, relative to the project root */
export function databasePath(options: SqliteOptions, root: string = process.cwd(), env: NodeJS.ProcessEnv = process.env): string {
  const path = env[PATH_ENV] || options.path || DEFAULT_PATH
  if (path === MEMORY)
    return path
  return isAbsolute(path)
    ? path
    : resolve(root, path)
}

const plugin: ServerPlugin = {
  name: 'SQLite',
  database(ctx: ServerPluginContext) {
    const options = ctx.options as SqliteOptions
    const path = databasePath(options, ctx.projectRoot)

    const db = openSqlite(path, options)

    ctx.logger?.info(path === MEMORY
      ? 'SQLite: in memory, the database is gone when the server stops'
      : `SQLite: ${path}`)
    return db
  },
}

export default plugin
