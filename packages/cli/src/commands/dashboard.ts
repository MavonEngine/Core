import type { MetricsSource } from '../dashboard/MetricsClient'
import type { ViewState } from '../dashboard/view'
import process from 'node:process'
import { parseArgs } from 'node:util'
import MetricsClient, { httpSource } from '../dashboard/MetricsClient'
import { simulatedSource } from '../dashboard/simulator'
import { readableTheme } from '../dashboard/theme'
import { handlePlayersKey, renderDashboard, tabForKey } from '../dashboard/view'

export const DASHBOARD_HELP = `Usage: mavonengine dashboard [options]

Live terminal dashboard for a running MavonEngine game server.

Options:
  --host <host>        Server host (default: localhost)
  --port <port>        Server HTTP port (default: 8050)
  --url <url>          Full metrics URL, overrides --host and --port
  --token <token>      Metrics token (or set MAVONENGINE_METRICS_TOKEN)
  --interval <ms>      Poll interval in ms (default: 1000)
  --theme <name>       dark, dracula, nord, tokyoNight, gruvbox, matrix, light, …
  --transparent        Let a transparent terminal background show through
                       (text can be hard to read over a light wallpaper)
  --sim                Show simulated data instead of connecting to a server
  -h, --help           Show this help
`

export interface DashboardOptions {
  source: MetricsSource
  intervalMs: number
  theme?: string
  transparent: boolean
  /** Show the startup screen until the server first answers (`mavonengine dev`) */
  startup?: {
    engineVersion?: string
    output(): string
  }
}

/** Poll interval while waiting for a server that is still starting, so the dashboard appears as soon as it is up */
const STARTUP_POLL_MS = 250

export class UsageError extends Error { }

/**
 * Turn CLI arguments into dashboard options. Throws UsageError on bad input.
 */
export function parseDashboardArgs(args: string[], env: Record<string, string | undefined> = process.env): DashboardOptions | 'help' {
  const { values } = parseArgs({
    args,
    options: {
      host: { type: 'string', default: 'localhost' },
      port: { type: 'string', default: '8050' },
      url: { type: 'string' },
      token: { type: 'string' },
      interval: { type: 'string', default: '1000' },
      theme: { type: 'string' },
      transparent: { type: 'boolean', default: false },
      sim: { type: 'boolean', default: false },
      help: { type: 'boolean', short: 'h', default: false },
    },
    strict: true,
    allowPositionals: false,
  })

  if (values.help)
    return 'help'

  const intervalMs = Number(values.interval)
  if (!Number.isInteger(intervalMs) || intervalMs < 100)
    throw new UsageError('--interval must be a whole number of ms, at least 100')

  if (values.sim)
    return { source: simulatedSource(), intervalMs, theme: values.theme, transparent: values.transparent }

  let url = values.url
  if (!url) {
    const port = Number(values.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      throw new UsageError('--port must be between 1 and 65535')

    const host = values.host!.includes(':') && !values.host!.startsWith('[') ? `[${values.host}]` : values.host
    url = `http://${host}:${port}/api/game/metrics`
  }

  try {
    void new URL(url)
  }
  catch {
    throw new UsageError(`Invalid --url: ${url}`)
  }

  const token = values.token ?? env.MAVONENGINE_METRICS_TOKEN

  return { source: httpSource({ url, token }), intervalMs, theme: values.theme, transparent: values.transparent }
}

/**
 * Run the dashboard until the user quits or `signal` aborts.
 */
export async function runDashboard(options: DashboardOptions, signal?: AbortSignal) {
  // Loaded lazily so `mavonengine --help` doesn't pay for the TUI
  const { createApp } = await import('@profullstack/hqtui')

  const client = new MetricsClient(options.source, {
    intervalMs: options.intervalMs,
    startupIntervalMs: options.startup ? STARTUP_POLL_MS : undefined,
  })
  const view: ViewState = { tab: 0, playerOffset: 0, logFromEnd: 0, requestTopId: null, selectedPlayerId: null, followSelectedPlayer: true }

  const app = await createApp({ fps: 15, theme: readableTheme(options.theme), paintBackground: !options.transparent })

  app.render(({ ui, theme }) => renderDashboard(ui, theme, client.state, view, {
    transparent: options.transparent,
    startup: options.startup && { engineVersion: options.startup.engineVersion, output: options.startup.output() },
  }))

  client.onChange(() => app.invalidate())

  app.on('key', (event) => {
    if (event.key === 'r')
      void client.refresh()

    const tab = tabForKey(event.key)
    if (tab !== null) {
      view.tab = tab
      app.invalidate()
    }

    if (handlePlayersKey(view, client.state.snapshot, event.key))
      app.invalidate()
  })

  app.on('exit', () => client.stop())

  const onAbort = () => app.stop()
  signal?.addEventListener('abort', onAbort)

  client.start()
  // stop() does nothing before start(), so an abort that already happened is checked here
  if (!signal?.aborted)
    await app.start()
  signal?.removeEventListener('abort', onAbort)
  client.stop()
}
