import type { ScatterBrush } from './scatterBrush.js'
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { pluginBrushDirs } from '../Plugins/ProjectConfig.js'
import { BRUSH_FILE_SUFFIX, BRUSH_NAME_RE, BRUSHES_DIR, parseScatterBrush } from './scatterBrush.js'

/**
 * Node only. Reading and writing the project's brush files, `<root>/brushes/<name>.brush.json`, for the dev server.
 */

export function brushFilePath(root: string, name: string): string {
  if (!BRUSH_NAME_RE.test(name))
    throw new Error(`Invalid brush name "${name}", use letters, digits, - and _`)
  return join(root, BRUSHES_DIR, `${name}${BRUSH_FILE_SUFFIX}`)
}

/** A brush as listed: a plugin's is named `<package>:<name>` and can't be saved over */
export type ListedBrush = ScatterBrush & { plugin?: string }

/** Every brush in the project, by file name. Broken files are passed to `onError` and left out */
export function readBrushes(root: string, onError?: (file: string, err: Error) => void): ScatterBrush[] {
  return readBrushDir(join(root, BRUSHES_DIR), onError)
}

/** The brushes the project has and those the enabled plugins ship */
export function listBrushes(root: string, onError?: (file: string, err: Error) => void): ListedBrush[] {
  return [
    ...readBrushes(root, onError),
    ...pluginBrushDirs(root).flatMap(plugin => readBrushDir(plugin.dir, onError)
      .map(brush => ({ ...brush, name: `${plugin.package}:${brush.name}`, plugin: plugin.package }))),
  ]
}

function readBrushDir(dir: string, onError?: (file: string, err: Error) => void): ScatterBrush[] {
  if (!existsSync(dir))
    return []
  return readdirSync(dir)
    .filter(file => file.endsWith(BRUSH_FILE_SUFFIX) && BRUSH_NAME_RE.test(file.slice(0, -BRUSH_FILE_SUFFIX.length)))
    .sort()
    .flatMap((file) => {
      const name = file.slice(0, -BRUSH_FILE_SUFFIX.length)
      try {
        return [
          {
            ...parseScatterBrush(JSON.parse(readFileSync(join(dir, file), 'utf8')), name),
            name,
          },
        ]
      }
      catch (err) {
        onError?.(file, err as Error)
        return []
      }
    })
}

/** Write a brush, named after the file. Written to a temporary file first and renamed */
export function writeBrushFile(root: string, name: string, data: unknown): ScatterBrush {
  const file = brushFilePath(root, name)
  const brush = {
    ...parseScatterBrush(data, name),
    name,
  }
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(brush, null, 2)}\n`)
  renameSync(tmp, file)
  return brush
}

export function deleteBrushFile(root: string, name: string): void {
  rmSync(brushFilePath(root, name), { force: true })
}
