import process from 'node:process'
import { version } from '../package.json'
import { BUILD_HELP, parseBuildArgs, runBuildCommand } from './commands/build'
import { CREATE_HELP, parseCreateArgs, runCreateCommand } from './commands/create'
import { DASHBOARD_HELP, parseDashboardArgs, runDashboard, UsageError } from './commands/dashboard'
import { DEV_HELP, parseDevArgs, runDevCommand } from './commands/dev'
import { DOCTOR_HELP, parseDoctorArgs, runDoctorCommand } from './commands/doctor'
import { INSTALL_HELP, parseInstallArgs, runInstallCommand } from './commands/install'
import { MAKE_PLUGIN_HELP, parseMakePluginArgs, runMakePluginCommand } from './commands/make'
import { MCP_HELP, parseMcpArgs, runMcpCommand } from './commands/mcp'
import { parsePluginsArgs, PLUGINS_HELP, runPluginsCommand } from './commands/plugins'
import { parsePublishArgs, PUBLISH_HELP, runPublishCommand } from './commands/publish'
import { parseUpgradeArgs, runUpgradeCommand, UPGRADE_HELP } from './commands/upgrade'

const HELP = `Usage: mavonengine <command> [options]

Commands:
  create         Create a project from the multiplayer template and start it
  dashboard      Live terminal dashboard for a running game server
  dev            Run the project's dev servers (game server and client)
  install        Install packages and register engine plugins in mavonengine.json
  plugins        List the plugins that are available to install
  asset:publish  Copy a plugin's files you may change, like the mail layout, into the project
  make:plugin    Create a plugin inside the project, linked and registered in mavonengine.json
  build          Build the project for release, with the plugin assets it uses
  doctor         Check Node, the @mavonengine packages, mavonengine.json and the plugins
  upgrade        Move to the latest @mavonengine/core and plugins that fit it, then migrate the project
  mcp            MCP server so AI assistants (any MCP client) can inspect a running game server

Options:
  -h, --help       Show help
  -v, --version    Show version

Run 'mavonengine <command> --help' for command options.
`

async function main(argv: string[]): Promise<number> {
  const [command, ...args] = argv

  if (!command || command === '-h' || command === '--help' || command === 'help') {
    process.stdout.write(HELP)
    return 0
  }

  if (command === '-v' || command === '--version') {
    process.stdout.write(`${version}\n`)
    return 0
  }

  if (command === 'create') {
    const options = parseCreateArgs(args)

    if (options === 'help') {
      process.stdout.write(CREATE_HELP)
      return 0
    }

    return runCreateCommand(options)
  }

  if (command === 'dashboard') {
    const options = parseDashboardArgs(args)

    if (options === 'help') {
      process.stdout.write(DASHBOARD_HELP)
      return 0
    }

    if (!process.stdout.isTTY || !process.stdin.isTTY) {
      process.stderr.write('mavonengine dashboard needs an interactive terminal\n')
      return 1
    }

    await runDashboard(options)
    return 0
  }

  if (command === 'dev') {
    const options = parseDevArgs(args)

    if (options === 'help') {
      process.stdout.write(DEV_HELP)
      return 0
    }

    return runDevCommand(options)
  }

  if (command === 'install' || command === 'i' || command === 'add') {
    const options = parseInstallArgs(args)

    if (options === 'help') {
      process.stdout.write(INSTALL_HELP)
      return 0
    }

    return runInstallCommand(options)
  }

  if (command === 'plugins') {
    const options = parsePluginsArgs(args)

    if (options === 'help') {
      process.stdout.write(PLUGINS_HELP)
      return 0
    }

    return runPluginsCommand(options)
  }

  if (command === 'asset:publish') {
    const options = parsePublishArgs(args)

    if (options === 'help') {
      process.stdout.write(PUBLISH_HELP)
      return 0
    }

    return runPublishCommand(options)
  }

  if (command === 'make:plugin') {
    const options = parseMakePluginArgs(args)

    if (options === 'help') {
      process.stdout.write(MAKE_PLUGIN_HELP)
      return 0
    }

    return runMakePluginCommand(options)
  }

  if (command === 'mcp') {
    const options = parseMcpArgs(args)

    if (options === 'help') {
      process.stdout.write(MCP_HELP)
      return 0
    }

    return runMcpCommand(options)
  }

  if (command === 'doctor') {
    const options = parseDoctorArgs(args)

    if (options === 'help') {
      process.stdout.write(DOCTOR_HELP)
      return 0
    }

    return runDoctorCommand(options)
  }

  if (command === 'upgrade') {
    const options = parseUpgradeArgs(args)

    if (options === 'help') {
      process.stdout.write(UPGRADE_HELP)
      return 0
    }

    return runUpgradeCommand(options)
  }

  if (command === 'build') {
    const options = parseBuildArgs(args)

    if (options === 'help') {
      process.stdout.write(BUILD_HELP)
      return 0
    }

    return runBuildCommand(options)
  }

  throw new UsageError(`Unknown command '${command}'\n\n${HELP}`)
}

main(process.argv.slice(2))
  .then(code => process.exit(code))
  .catch((err: Error) => {
    // parseArgs throws TypeErrors with an ERR_PARSE_ARGS_* code for bad flags
    const isUsage = err instanceof UsageError || (err as NodeJS.ErrnoException).code?.startsWith('ERR_PARSE_ARGS')
    process.stderr.write(`mavonengine: ${err.message}\n`)
    process.exit(isUsage ? 2 : 1)
  })
