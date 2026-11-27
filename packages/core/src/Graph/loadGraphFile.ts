import type { GraphData } from './types.js'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import { pluginGraphDirs } from '../Plugins/ProjectConfig.js'
import { GRAPH_NAME_RE, GRAPHS_DIR, parseGraphData, parseGraphName } from './types.js'

/**
 * Node only. Reading and writing graph files, for the server and the dev server.
 */

const GRAPH_EXT = '.graph.json'

/** `<root>/graphs/<name>.graph.json` */
export function graphFilePath(root: string, name: string): string {
  if (!GRAPH_NAME_RE.test(name))
    throw new Error(`Invalid graph name "${name}", use letters, digits, - and _`)
  return join(root, GRAPHS_DIR, `${name}${GRAPH_EXT}`)
}

/**
 * The file of a graph by its name: the project's `graphs/<name>.graph.json`, or for `<package>:<name>` the graph an
 * enabled plugin ships in its own `graphs/`
 */
export function resolveGraphFile(root: string, name: string): string {
  const parsed = parseGraphName(name)
  if (!parsed)
    throw new Error(`Invalid graph name "${name}"`)
  if (!parsed.plugin)
    return graphFilePath(root, parsed.name)
  const plugin = pluginGraphDirs(root).find(p => p.package === parsed.plugin)
  if (!plugin)
    throw new Error(`Graph ${name}: ${parsed.plugin} is not an enabled plugin with a graphs directory`)
  return join(plugin.dir, `${parsed.name}${GRAPH_EXT}`)
}

/** Read a graph by its name, see `resolveGraphFile()`. Named after it, `<package>:<name>` for a plugin's */
export function readGraph(root: string, name: string): GraphData {
  const graph = readGraphFile(resolveGraphFile(root, name))
  return { ...graph, name }
}

/** The graph name of a graph file path: `graphs/lava.graph.json` → `lava` */
export function graphNameOf(file: string): string {
  return basename(file, GRAPH_EXT)
}

export function readGraphFile(file: string): GraphData {
  let json: unknown
  try {
    json = JSON.parse(readFileSync(file, 'utf8'))
  }
  catch (err) {
    throw new Error(`Could not read graph ${file}: ${(err as Error).message}`)
  }
  return parseGraphData(json, graphNameOf(file))
}

/**
 * Write a graph file. Written to a temporary file first and renamed, so a watcher never reads half of it.
 */
export function writeGraphFile(file: string, data: unknown): GraphData {
  const graph = parseGraphData(data, graphNameOf(file))
  mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  writeFileSync(tmp, `${JSON.stringify(graph, null, 2)}\n`)
  renameSync(tmp, file)
  return graph
}
