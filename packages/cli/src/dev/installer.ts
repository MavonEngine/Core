import type { InstallJob } from '@mavonengine/core/Plugins/install'
import { invalidPackages } from '@mavonengine/core/Plugins/install'
import { runInstallCommand } from '../commands/install'
import { runCommand } from '../create/project'

/** How much of an install's output is kept */
export const MAX_INSTALL_OUTPUT = 20_000

export class InstallRefused extends Error {
  constructor(message: string, readonly reason: 'invalid' | 'busy') {
    super(message)
  }
}

export interface PluginInstallerOptions {
  /** The project to install into */
  root: string
  /** Stop the dev script and start it again, so new plugins are loaded */
  restart(): Promise<void>
  /** Install `packages` into `root`, writing progress to `write`. Resolves with an exit code. Default: `mavonengine install --yes` */
  install?(root: string, packages: string[], write: (text: string) => void): Promise<number>
}

function installWithCli(root: string, packages: string[], write: (text: string) => void): Promise<number> {
  return runInstallCommand({ cwd: root, packages, yes: true, register: true }, {
    run: (command, args, cwd) => runCommand(command, args, cwd, { report: { step: () => {}, output: write } }),
    // Whoever asked for the install already agreed to it
    confirm: async () => true,
    interactive: false,
    write,
  })
}

/**
 * Installs packages into the project `mavonengine dev` runs, then restarts its dev script.
 * One install at a time. The dashboard uses it directly, the editor through the dev control server.
 */
export default class PluginInstaller {
  /** The running or last install */
  job: InstallJob | null = null
  /** Settles when the current install and the restart after it are over */
  finished: Promise<void> = Promise.resolve()

  private nextId = 1
  private listeners = new Set<(job: InstallJob) => void>()

  constructor(private options: PluginInstallerOptions) {}

  get busy(): boolean {
    return this.job?.status === 'installing' || this.job?.status === 'restarting'
  }

  onChange(listener: (job: InstallJob) => void) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  /**
   * Start installing `packages`. Throws InstallRefused when they can't be installed or an install is running.
   */
  start(packages: unknown): InstallJob {
    const invalid = invalidPackages(packages)
    if (invalid)
      throw new InstallRefused(invalid, 'invalid')
    if (this.busy)
      throw new InstallRefused(`Still installing ${this.job!.packages.join(', ')}`, 'busy')

    const job: InstallJob = { id: this.nextId++, packages: [...packages as string[]], status: 'installing', output: '' }
    this.job = job
    this.finished = this.run(job)
    return job
  }

  private async run(job: InstallJob) {
    const changed = () => this.listeners.forEach(listener => listener(job))
    const write = (text: string) => {
      job.output = (job.output + text).slice(-MAX_INSTALL_OUTPUT)
      changed()
    }

    changed()

    try {
      const code = await (this.options.install ?? installWithCli)(this.options.root, job.packages, write)
      if (code !== 0)
        throw new Error('The packages were installed, but not all of them could be set up as plugins')

      job.status = 'restarting'
      write('\nmavonengine: restarting the dev script to load what was installed\n')
      await this.options.restart()
      job.status = 'done'
    }
    catch (err) {
      job.status = 'failed'
      job.error = (err as Error).message
    }

    changed()
  }
}
