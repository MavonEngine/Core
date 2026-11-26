import type { Kysely } from 'kysely'
import { migrationsTableName, tableName } from './tables'

/**
 * Only types are imported from kysely: the engine works with the instance a database plugin gives it,
 * so a game without one doesn't need kysely installed.
 */

export interface MigrationTools {
  /** The plugin's name for one of its tables, e.g. `table('mutes')` → `chat_mutes` */
  table(name: string): string
}

export interface PluginMigration {
  /** Change the schema. Runs in a transaction where the database allows it (not on MySQL) */
  up(db: Kysely<any>, tools: MigrationTools): Promise<void>
}

/**
 * Run the migrations of one plugin that haven't run yet, in the order of their names, and return their names.
 * Each one runs in a transaction together with recording it, so a migration that fails is neither half done
 * nor recorded, and is tried again next time. The migrations before it stay applied.
 */
export async function runPluginMigrations(db: Kysely<any>, pkg: string, migrations: Record<string, PluginMigration>): Promise<string[]> {
  const table = migrationsTableName(pkg)
  const tools: MigrationTools = {
    table: name => tableName(pkg, name),
  }

  await db.schema
    .createTable(table)
    .ifNotExists()
    .addColumn('name', 'varchar(255)', column => column.primaryKey())
    .addColumn('executed_at', 'varchar(32)', column => column.notNull())
    .execute()

  const executed = new Set((await db.selectFrom(table).select('name').execute()).map(row => row.name as string))
  const applied: string[] = []

  for (const name of Object.keys(migrations).sort()) {
    if (executed.has(name))
      continue

    const migration = migrations[name]
    if (typeof migration?.up !== 'function')
      throw new TypeError(`Migration ${name} has no up()`)

    try {
      await db.transaction().execute(async (trx) => {
        await migration.up(trx, tools)
        await trx.insertInto(table).values({
          name,
          executed_at: new Date().toISOString(),
        }).execute()
      })
    }
    catch (err) {
      throw Object.assign(new Error(`Migration ${name} failed: ${(err as Error).message}`), { cause: err })
    }

    applied.push(name)
  }

  return applied
}

export function hasMigrations(plugin: { migrations?: Record<string, PluginMigration> }): boolean {
  return !!plugin.migrations && Object.keys(plugin.migrations).length > 0
}
