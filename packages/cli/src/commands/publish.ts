import { relative, resolve } from 'node:path'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { PluginConfigError, readPluginManifest } from '@mavonengine/core/Plugins/ProjectConfig'
import { PUBLISHED_DIR, publishFiles } from '@mavonengine/core/Plugins/publish'
import { UsageError } from './dashboard'
import { findProjectRoot } from './dev'

export const PUBLISH_HELP = `Usage: mavonengine asset:publish <package...> [options]

Copy the files a plugin lets you change, like the mail plugin's layout, into the project's
${PUBLISHED_DIR}/<package>/. The plugin uses your copy from then on, so change it there.

Files you have already are kept, so publishing again only adds the plugin's new files.

Options:
  --force            Replace the files you have with the plugin's
  --cwd <dir>        Start looking for the project here (default: current directory)
  -h, --help         Show this help
`

export interface PublishOptions {
  cwd: string
  packages: string[]
  force: boolean
}

export interface PublishIO {
  write(text: string): void
}

/**
 * Turn CLI arguments into options. Throws UsageError on bad input.
 */
export function parsePublishArgs(args: string[], cwd = process.cwd()): PublishOptions | 'help' {
  const { values, positionals } = parseArgs({
    args,
    options: {
      force: { type: 'boolean', default: false },
      cwd: { type: 'string' },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: true,
  })

  if (values.help)
    return 'help'

  if (positionals.length === 0)
    throw new UsageError(`name the plugin to publish, e.g. mavonengine asset:publish @mavonengine/mail\n\n${PUBLISH_HELP}`)

  return {
    cwd: resolve(cwd, values.cwd ?? '.'),
    packages: positionals,
    force: values.force,
  }
}

export async function runPublishCommand(options: PublishOptions, io: PublishIO = {
  write: text => void process.stdout.write(text),
}): Promise<number> {
  const root = findProjectRoot(options.cwd)
  if (!root) {
    io.write(`No MavonEngine project found from ${options.cwd}. Run this inside one.\n`)
    return 1
  }

  let failed = false
  for (const pkg of options.packages) {
    const plugin = (() => {
      try {
        return readPluginManifest(root, pkg)
      }
      catch (err) {
        io.write(`${pkg}: ${(err as Error).message}\n`)
        return null
      }
    })()
    if (plugin === null) {
      failed = true
      continue
    }
    if (!plugin) {
      io.write(`${pkg} isn't installed, or is no MavonEngine plugin. Install it with: mavonengine install ${pkg}\n`)
      failed = true
      continue
    }

    try {
      const files = publishFiles(root, plugin, { force: options.force })
      io.write(`${pkg}:\n`)
      for (const file of files) {
        const shown = relative(root, file.to).split('\\').join('/')
        io.write(file.status === 'kept'
          ? `  kept       ${shown} (you have it already, --force replaces it)\n`
          : `  ${file.status.padEnd(10)} ${shown}\n`)
      }
      if (files.length === 0)
        io.write('  nothing to publish\n')
    }
    catch (err) {
      if (!(err instanceof PluginConfigError))
        throw err
      io.write(`${err.message}\n`)
      failed = true
    }
  }

  return failed ? 1 : 0
}
