import { existsSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const SRC = resolve(__dirname, '../../src')
// Value imports: `import type` is erased and needs no file at runtime
const IMPORT_RE = /^(?:import|export) (?!type\b)[^'"]*from '(\.{1,2}\/[^']+)'/gm

/**
 * The Vite plugin runs in Node straight from dist (no bundler), where relative imports need their `.js`. Every module
 * it loads, directly or not, has to write them that way
 */
describe('the Vite plugin\'s imports', () => {
  it('end in .js all the way down', () => {
    const missing: string[] = []
    const seen = new Set<string>()
    const visit = (file: string) => {
      if (seen.has(file))
        return
      seen.add(file)
      for (const [, specifier] of readFileSync(file, 'utf8').matchAll(IMPORT_RE)) {
        if (!specifier!.endsWith('.js')) {
          missing.push(`${file.slice(SRC.length + 1)}: '${specifier}'`)
          continue
        }
        const target = join(dirname(file), specifier!.replace(/\.js$/, '.ts'))
        if (existsSync(target))
          visit(target)
      }
    }
    visit(join(SRC, 'Plugins/vite.ts'))

    expect(missing).toEqual([])
    expect(seen.size).toBeGreaterThan(5)
  })
})
