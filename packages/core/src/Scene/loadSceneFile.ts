import type { SceneData } from './types.js'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, extname, join } from 'node:path'
import { parseSceneData, SCENE_NAME_RE, SCENES_DIR } from './types.js'

/**
 * Node only. Reading and writing scene files, for the server and the dev server.
 */

/** `<root>/scenes/<name>.json` */
export function sceneFilePath(root: string, name: string): string {
  if (!SCENE_NAME_RE.test(name))
    throw new Error(`Invalid scene name "${name}", use letters, digits, - and _`)
  return join(root, SCENES_DIR, `${name}.json`)
}

/** The scene name of a scene file path: `scenes/main.json` → `main` */
export function sceneNameOf(file: string): string {
  return basename(file, extname(file))
}

export function readSceneFile(file: string): SceneData {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(file, 'utf8'))
  }
  catch (err) {
    throw new Error(`Could not read scene ${file}: ${(err as Error).message}`)
  }
  return parseSceneData(json, sceneNameOf(file))
}

/**
 * Write a scene file. Written to a temporary file first and renamed,
 * so a server watching the file never reads half of it.
 */
export function writeSceneFile(file: string, data: unknown): SceneData {
  const scene = parseSceneData(data, sceneNameOf(file))
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(scene, null, 2)}\n`)
  renameSync(tmp, file)
  return scene
}
