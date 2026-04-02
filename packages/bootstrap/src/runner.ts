import { spawnSync } from 'node:child_process'
import process from 'node:process'

export function runCommand(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    shell: process.platform === 'win32',
  })

  if (result.error) {
    throw result.error
  }

  if (result.status !== 0) {
    throw new Error(`Command "${command} ${args.join(' ')}" exited with code ${result.status}`)
  }
}
