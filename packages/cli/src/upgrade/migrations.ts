import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import * as bundled from '@mavonengine/core/Migrations/index'
import { findPackageDir } from '@mavonengine/core/Plugins/ProjectConfig'

export type MigrationsModule = typeof bundled

/**
 * The migrations of the project's installed @mavonengine/core, so a core the CLI doesn't know yet decides what
 * to migrate. Falls back to the ones the CLI was built with when the installed core has none (older than
 * migrations, or not built) or speaks a newer API.
 */
export async function loadMigrations(root: string): Promise<{ module: MigrationsModule, from: 'project' | 'cli' }> {
  const dir = findPackageDir(root, '@mavonengine/core')
  const file = dir
    ? join(dir, 'dist', 'Migrations', 'index.js')
    : undefined

  if (file && existsSync(file)) {
    try {
      const module = await import(pathToFileURL(file).href) as MigrationsModule
      if (module.MIGRATIONS_API === bundled.MIGRATIONS_API && Array.isArray(module.MIGRATIONS))
        return { module, from: 'project' }
    }
    catch {
      // A core that can't be imported here gets the CLI's migrations
    }
  }

  return { module: bundled, from: 'cli' }
}
