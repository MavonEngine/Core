import type { Migration, MigrationContext } from './migrations.js'
import type { FileChange } from './ProjectFiles.js'
import { compareVersions, parseVersion } from '../Plugins/compat.js'
import { MIGRATIONS } from './migrations.js'
import { ProjectFiles } from './ProjectFiles.js'

/**
 * Node only. The migrations of this @mavonengine/core, for `mavonengine upgrade` and `mavonengine doctor`. The CLI
 * loads this file from the project's installed core, so it is the new core that says what to migrate.
 */

export type { FileChange, Migration, MigrationContext }
export { MIGRATIONS, ProjectFiles }

/** Bumped when this module's exports change in a way the CLI has to know about */
export const MIGRATIONS_API = 1

const CONFIG = 'mavonengine.json'

/** The migrations a project on @mavonengine/core `coreVersion` can have, oldest first */
export function migrationsFor(coreVersion: string, migrations: Migration[] = MIGRATIONS): Migration[] {
  const core = parseVersion(coreVersion)
  if (!core)
    return []

  return migrations.filter((migration) => {
    const since = parseVersion(migration.since)
    // A prerelease of a version counts as that version, so a local build gets its migrations
    return since && compareVersions({ ...core, prerelease: [] }, since) >= 0
  })
}

/** The ids in `migrations` of the project's mavonengine.json */
export function recordedMigrations(files: ProjectFiles): string[] {
  const recorded = files.readJson(CONFIG)?.migrations
  return Array.isArray(recorded)
    ? recorded.filter(id => typeof id === 'string')
    : []
}

/**
 * The migrations the project still needs: those its core can have, that aren't recorded as done in
 * mavonengine.json, and that would change something.
 */
export function pendingMigrations(ctx: MigrationContext, migrations: Migration[] = MIGRATIONS): Migration[] {
  const done = new Set(recordedMigrations(ctx.files))
  return migrationsFor(ctx.versions.core, migrations).filter(migration => !done.has(migration.id) && migration.applies(ctx))
}

/**
 * Run `pending` against `ctx.files` and record every migration the core can have as done, so one that didn't
 * apply, or one a project undoes on purpose, isn't offered again. Nothing is written until `ctx.files.commit()`.
 */
export function applyMigrations(ctx: MigrationContext, pending: Migration[], migrations: Migration[] = MIGRATIONS): FileChange[] {
  for (const migration of pending)
    migration.run(ctx)

  const config = ctx.files.readJson(CONFIG) ?? { plugins: {} }
  const recorded = new Set(recordedMigrations(ctx.files))
  const ids = migrationsFor(ctx.versions.core, migrations).map(migration => migration.id)
  if (ids.some(id => !recorded.has(id))) {
    config.migrations = [
      ...recorded,
      ...ids.filter(id => !recorded.has(id)),
    ]
    ctx.files.writeJson(CONFIG, config)
  }

  return ctx.files.changes()
}
