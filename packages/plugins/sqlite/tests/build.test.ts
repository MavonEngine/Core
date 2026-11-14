import type { Kysely } from 'kysely'
import { readFileSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { sql } from 'kysely'
import { build } from 'tsup'
import { afterAll, describe, expect, it } from 'vitest'
import config from '../tsup.config'

// Inside the package, so the built file finds kysely in node_modules the way an installed plugin does
const outDir = resolve(import.meta.dirname, '../node_modules/.cache/build-test')

afterAll(() => {
  rmSync(outDir, { recursive: true, force: true })
})

describe('the built plugin', () => {
  it('imports node:sqlite by its full name and runs queries', async () => {
    await build({ ...(config as object), entry: [resolve(import.meta.dirname, '../src/index.ts')], outDir, clean: true, silent: true })
    const file = join(outDir, 'index.js')

    // node:sqlite has no name without the prefix: a bundler that drops it breaks the plugin
    expect(readFileSync(file, 'utf8')).toMatch(/from\s*["']node:sqlite["']/)

    const built = await import(pathToFileURL(file).href)
    const db: Kysely<any> = built.openSqlite(':memory:')
    expect((await sql<{ n: number }>`select 41 + 1 as n`.execute(db)).rows).toEqual([{ n: 42 }])
    await db.destroy()
  }, 30_000)
})
