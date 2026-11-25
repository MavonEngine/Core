import type { Kysely } from 'kysely'
import { readFileSync, rmSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import process from 'node:process'
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
    // tsup takes entries as globs, where a backslash escapes: on Windows a resolved path matches nothing
    const entry = relative(process.cwd(), resolve(import.meta.dirname, '../src/index.ts')).split(sep).join('/')
    // tsup picks .js or .mjs by the package.json where it runs, so from the repo root it would be .mjs
    await build({
      ...(config as object),
      entry: [entry],
      outDir,
      outExtension: () => ({ js: '.js' }),
      clean: true,
      silent: true,
    })
    const file = join(outDir, 'index.js')

    // node:sqlite has no name without the prefix: a bundler that drops it breaks the plugin
    expect(readFileSync(file, 'utf8')).toMatch(/from\s*["']node:sqlite["']/)

    const built = await import(pathToFileURL(file).href)
    const db: Kysely<any> = built.openSqlite(':memory:')
    expect((await sql<{ n: number }>`select 41 + 1 as n`.execute(db)).rows).toEqual([
      { n: 42 },
    ])
    await db.destroy()
  }, 30_000)
})
