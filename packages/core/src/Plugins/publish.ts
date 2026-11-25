import type { InstalledPlugin } from './ProjectConfig'
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, sep } from 'node:path'
import { PluginConfigError, resolveInside } from './ProjectConfig'

/**
 * Node only: the files plugins let a project change. A plugin names a directory of them as `publish` in its manifest,
 * `mavonengine asset:publish <package>` copies them into the project, and the plugin uses the project's copy.
 */

/** Where published files go in a project: `resources/<package>/…` */
export const PUBLISHED_DIR = 'resources'

/** The project's directory of the files `pkg` published */
export function publishedDir(root: string, pkg: string): string {
  return join(root, PUBLISHED_DIR, ...pkg.split('/'))
}

/**
 * The project's copy of a file `pkg` publishes, e.g. `publishedFile(root, '@mavonengine/mail', 'layout.html')`.
 * Undefined when the project has none, so the plugin uses its own. `path` can't point outside the plugin's directory
 */
export function publishedFile(root: string, pkg: string, path: string): string | undefined {
  const file = resolveInside(publishedDir(root, pkg), path)
  return file && existsSync(file) && statSync(file).isFile()
    ? file
    : undefined
}

/** The plugin's directory of files to publish, undefined when it publishes none */
export function publishSourceDir(plugin: InstalledPlugin): string | undefined {
  const dir = plugin.manifest.publish
  if (dir === undefined)
    return undefined
  const full = resolveInside(plugin.dir, dir)
  if (!full)
    throw new PluginConfigError(`${plugin.package}: "mavonengine.publish" must be inside the package`)
  return full
}

function filesIn(dir: string): string[] {
  const files: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory())
      files.push(...filesIn(path))
    else if (entry.isFile())
      files.push(path)
  }
  return files.sort()
}

export interface PublishedFile {
  /** Relative to the plugin's publish directory, with `/` */
  path: string
  /** Absolute path in the project */
  to: string
  /** `published` when it was copied, `kept` when the project had it already, `replaced` when `force` copied it over */
  status: 'published' | 'kept' | 'replaced'
}

/**
 * Copy the plugin's files to publish into the project. Files the project has already are kept, as they may have been
 * changed, unless `force`. Throws a PluginConfigError for a plugin that publishes nothing.
 */
export function publishFiles(root: string, plugin: InstalledPlugin, { force = false } = {}): PublishedFile[] {
  const source = publishSourceDir(plugin)
  if (!source)
    throw new PluginConfigError(`${plugin.package} has no files to publish`)
  if (!existsSync(source) || !statSync(source).isDirectory())
    throw new PluginConfigError(`${plugin.package}: its publish directory ${relative(plugin.dir, source)} is missing`)

  const target = publishedDir(root, plugin.package)
  return filesIn(source).map((from) => {
    const path = relative(source, from).split(sep).join('/')
    const to = join(target, ...path.split('/'))
    const existed = existsSync(to)
    if (existed && !force)
      return { path, to, status: 'kept' as const }

    mkdirSync(dirname(to), { recursive: true })
    copyFileSync(from, to)
    return {
      path,
      to,
      status: existed ? 'replaced' as const : 'published' as const,
    }
  })
}
