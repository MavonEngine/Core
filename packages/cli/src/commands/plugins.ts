import type { AvailablePlugin, PluginRegistry } from '@mavonengine/core/Plugins/registry'
import { resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { CONFIG_FILE, findConfigRoot, readConfig } from '@mavonengine/core/Plugins/ProjectConfig'
import { fetchPluginRegistry, PLUGIN_REGISTRY_ENV, PLUGIN_REGISTRY_URL, SUPPORTED_REGISTRY_VERSION } from '@mavonengine/core/Plugins/registry'
import { UsageError } from './dashboard'

export const PLUGINS_HELP = `Usage: mavonengine plugins [options]

List the plugins that are available to install. The list is plugins.json on the main branch
of the MavonEngine repository, read from GitHub every time:
  ${PLUGIN_REGISTRY_URL}

Inside a project it also says which of them the project already has in ${CONFIG_FILE}.

Options:
  --url <url>        Read the list from here instead (also ${PLUGIN_REGISTRY_ENV})
  --json             Print the list as JSON
  --cwd <dir>        Look for the project here (default: current directory)
  -h, --help         Show this help
`

export interface PluginsOptions {
  cwd: string
  url: string
  json: boolean
}

export interface PluginsIO {
  fetch?: typeof globalThis.fetch
  write(text: string): void
}

/**
 * Turn CLI arguments into options. Throws UsageError on bad input.
 */
export function parsePluginsArgs(args: string[], cwd = process.cwd(), env: Record<string, string | undefined> = process.env): PluginsOptions | 'help' {
  const { values, positionals } = parseArgs({
    args,
    options: {
      url: { type: 'string' },
      json: { type: 'boolean', default: false },
      cwd: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  })

  if (values.help)
    return 'help'

  if (positionals.length > 0)
    throw new UsageError(`unexpected argument '${positionals[0]}'\n\n${PLUGINS_HELP}`)

  return {
    cwd: resolve(cwd, values.cwd ?? '.'),
    url: values.url ?? env[PLUGIN_REGISTRY_ENV] ?? PLUGIN_REGISTRY_URL,
    json: values.json,
  }
}

type ProjectState = 'enabled' | 'disabled' | undefined

/**
 * Whether the project around `cwd` has each plugin in its mavonengine.json. Empty outside a project.
 */
export function projectPlugins(cwd: string): Map<string, ProjectState> {
  const states = new Map<string, ProjectState>()
  const root = findConfigRoot(cwd)
  if (!root)
    return states

  try {
    for (const [pkg, entry] of Object.entries(readConfig(root).plugins))
      states.set(pkg, entry?.enabled === false ? 'disabled' : 'enabled')
  }
  catch {
    // An unreadable mavonengine.json is the project's problem, not the list's
  }

  return states
}

const TARGETS = { client: 'client', server: 'server', both: 'client + server' }

export function formatPlugins(registry: PluginRegistry, inProject: Map<string, ProjectState>): string {
  const { plugins } = registry
  const lines = [`${plugins.length} plugin${plugins.length === 1 ? '' : 's'} available, from ${registry.url}`, '']

  if (registry.version > SUPPORTED_REGISTRY_VERSION)
    lines.push('The list is in a newer format than this CLI knows, update @mavonengine/cli to see everything in it.', '')

  const width = Math.max(0, ...plugins.map(plugin => plugin.package.length))

  for (const plugin of plugins) {
    const state = inProject.get(plugin.package)
    const facts = [
      plugin.target ? `runs on ${TARGETS[plugin.target]}` : undefined,
      plugin.engine ? `@mavonengine/core ${plugin.engine}` : undefined,
      state === 'enabled' ? 'in this project' : state === 'disabled' ? 'in this project, disabled' : undefined,
    ].filter(Boolean)

    lines.push(`  ${plugin.package.padEnd(width)}  ${plugin.name === plugin.package ? '' : plugin.name}`.trimEnd())
    if (plugin.description)
      lines.push(`    ${plugin.description}`)
    if (facts.length)
      lines.push(`    ${facts.join(' · ')}`)
    if (plugin.homepage)
      lines.push(`    ${plugin.homepage}`)
    lines.push('')
  }

  lines.push(plugins.length ? 'Install one with: mavonengine install <package>' : 'The list is empty.')
  return `${lines.join('\n')}\n`
}

export async function runPluginsCommand(options: PluginsOptions, io: PluginsIO = { write: text => process.stdout.write(text) }): Promise<number> {
  const registry = await fetchPluginRegistry({ url: options.url, fetch: io.fetch })

  if (options.json) {
    io.write(`${JSON.stringify(registry, null, 2)}\n`)
    return 0
  }

  io.write(formatPlugins(registry, projectPlugins(options.cwd)))
  return 0
}

export type { AvailablePlugin }
