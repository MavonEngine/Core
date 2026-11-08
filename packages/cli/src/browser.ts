import { spawn } from 'node:child_process'
import process from 'node:process'

const AMPERSAND_RE = /&/g

/**
 * The command that opens `url` in the default browser on `platform`.
 */
export function openCommand(url: string, platform: NodeJS.Platform = process.platform): [string, string[]] {
  if (platform === 'darwin')
    return ['open', [url]]

  // `start` treats its first quoted argument as the window title, and & ends a cmd command
  if (platform === 'win32')
    return ['cmd', ['/c', 'start', '""', url.replace(AMPERSAND_RE, '^&')]]

  return ['xdg-open', [url]]
}

/**
 * Open `url` in the default browser, without waiting for it. Failing to is not an error worth stopping for.
 */
export function openBrowser(url: string) {
  const [command, args] = openCommand(url)

  try {
    const child = spawn(command, args, { stdio: 'ignore', detached: true, windowsHide: true })
    child.on('error', () => {})
    child.unref()
  }
  catch {
    // No opener on this system
  }
}

/**
 * Whether the browser would open on a screen in front of the user, rather than on the far end of an SSH session.
 */
export function canOpenBrowserHere(env: Record<string, string | undefined> = process.env) {
  return !env.SSH_CONNECTION && !env.SSH_TTY
}

/**
 * Whether `url` answers with a page, so a server that doesn't serve the client isn't opened as a 404.
 */
export async function servesPage(url: string, { timeoutMs = 3000, fetch = globalThis.fetch } = {}): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) })
    await res.body?.cancel()
    return res.ok && (res.headers.get('content-type') ?? '').includes('text/html')
  }
  catch {
    return false
  }
}
