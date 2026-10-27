import process from 'node:process'
import { version } from '../package.json'
import { CREATE_HELP, parseCreateArgs, runCreateCommand } from './commands/create'
import { DASHBOARD_HELP, parseDashboardArgs, runDashboard, UsageError } from './commands/dashboard'
import { DEV_HELP, parseDevArgs, runDevCommand } from './commands/dev'

const HELP = `Usage: mavonengine <command> [options]

Commands:
  create       Create a project from the multiplayer template and start it
  dashboard    Live terminal dashboard for a running game server
  dev          Run the project's dev servers (game server and client)

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
