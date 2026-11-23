import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

/**
 * Shared by the `make:*` generators: what they write, and the names they derive from what was typed.
 * Templates are plain functions returning file contents, so they ship inside the bundled CLI.
 */

/** Files to write, by path relative to the directory they go into */
export type ScaffoldFiles = Record<string, string>

/** An npm package name, optionally scoped. Lower case, like npm requires for new packages */
export const PACKAGE_NAME_RE = /^(?:@[a-z0-9][\w.~-]*\/)?[a-z0-9][\w.~-]*$/

const WORD_SEPARATORS_RE = /[^a-z0-9]+/i

/** The words of a name, without its npm scope: `@acme/forest-trees` → `['forest', 'trees']` */
export function nameWords(name: string): string[] {
  return name.split('/').at(-1)!.split(WORD_SEPARATORS_RE).filter(Boolean)
}

/** `@acme/forest-trees` → `forest-trees`, for directories and URL paths */
export function kebabName(name: string): string {
  return nameWords(name).map(word => word.toLowerCase()).join('-')
}

/** `@acme/forest-trees` → `Forest Trees`, for what people read */
export function titleName(name: string): string {
  return nameWords(name).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ')
}

/** `@acme/forest-trees` → `ForestTrees`, for classes and types */
export function pascalName(name: string): string {
  return titleName(name).split(' ').join('')
}

/**
 * Write `files` into `dir`, which must not exist yet, so nothing is ever overwritten.
 * Returns the paths written, relative to `dir`.
 */
export function writeScaffold(dir: string, files: ScaffoldFiles): string[] {
  if (existsSync(dir))
    throw new Error(`${dir} already exists`)

  const root = resolve(dir)
  const paths = Object.keys(files)
  for (const path of paths) {
    const full = resolve(root, path)
    const inside = relative(root, full)
    if (!inside || inside.startsWith('..') || isAbsolute(inside))
      throw new Error(`Refusing to write ${path} outside ${dir}`)
  }

  for (const path of paths) {
    const full = join(root, path)
    mkdirSync(dirname(full), { recursive: true })
    writeFileSync(full, files[path])
  }

  return paths
}
