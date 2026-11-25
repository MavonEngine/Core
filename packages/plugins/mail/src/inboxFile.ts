import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import process from 'node:process'

/**
 * Where the game server says its dev inbox runs, for the plugin's dev entry: MailDev listens on a free port, which only
 * the server knows. In the plugin's data directory, `<project root>/.mavonengine/plugins/@mavonengine/mail/`, the same
 * as the dev entry's `ctx.dataDir`. Written when MailDev started, removed when the server stops.
 */
export const INBOX_FILE = 'inbox.json'

export interface InboxLocation {
  /** MailDev's REST API, e.g. `http://127.0.0.1:41234/admin/mail/inbox/api` */
  api: string
  /** The game server's process */
  pid: number
}

/** The plugin's data directory in a project, where `ctx.dataDir` of its dev entry points */
export function mailDataDir(projectRoot: string): string {
  return join(projectRoot, '.mavonengine', 'plugins', '@mavonengine', 'mail')
}

export function writeInboxLocation(dataDir: string, webPort: number, basePath: string): InboxLocation {
  const location: InboxLocation = {
    api: `http://127.0.0.1:${webPort}${basePath}/api`,
    pid: process.pid,
  }
  const file = join(dataDir, INBOX_FILE)
  mkdirSync(dirname(file), { recursive: true })
  writeFileSync(file, `${JSON.stringify(location, null, 2)}\n`)
  return location
}

/** The inbox the file names, undefined without one or when it can't be read */
export function readInboxLocation(dataDir: string): InboxLocation | undefined {
  try {
    const location = JSON.parse(readFileSync(join(dataDir, INBOX_FILE), 'utf8')) as Partial<InboxLocation>
    return typeof location.api === 'string' && location.api.startsWith('http://127.0.0.1:') && typeof location.pid === 'number'
      ? { api: location.api, pid: location.pid }
      : undefined
  }
  catch {
    return undefined
  }
}

/** Remove the file, unless another server has written its own since */
export function removeInboxLocation(dataDir: string, ours: InboxLocation): void {
  const current = readInboxLocation(dataDir)
  if (current && (current.api !== ours.api || current.pid !== ours.pid))
    return
  rmSync(join(dataDir, INBOX_FILE), { force: true })
}
