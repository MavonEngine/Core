import type { MetricsSource } from '../dashboard/MetricsClient'
import type { StartupInfo, ViewState } from '../dashboard/view'
import type PluginInstaller from '../dev/installer'
import process from 'node:process'
import { parseArgs } from 'node:util'
import { notInProject } from '@mavonengine/core/Plugins/registry'
import { openBrowser, servesPage } from '../browser'
import AvailablePlugins from '../dashboard/available'
import MetricsClient, { httpSource } from '../dashboard/MetricsClient'
import { simulatedSource } from '../dashboard/simulator'
import { readableTheme } from '../dashboard/theme'
import { handleInstallKey, handleNetworkKey, handlePlayersKey, handlePluginsKey, initialViewState, renderDashboard, showsNetwork, tabForKey } from '../dashboard/view'

export const DASHBOARD_HELP = `Usage: mavonengine dashboard [options]

Live terminal dashboard for a running MavonEngine game server.

Options:
  --host <host>        Server host (default: localhost)
  --port <port>        Server HTTP port (default: 8050)
  --url <url>          Full metrics URL, overrides --host and --port
  --token <token>      Metrics or admin token (or set MAVONENGINE_METRICS_TOKEN
                       or MAVONENGINE_ADMIN_TOKEN)
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
  /** Page the game server serves the client on, opened with `o` */
  clientUrl?: string
  /** Open `clientUrl` in the browser once the server first answers, if it serves a page there */
  openBrowser?: boolean
  /** Show the startup screen until the server first answers (`mavonengine dev`), read every frame */
  startup?(): StartupInfo
  /** Lets the Plugins tab install plugins and restart the dev script (`mavonengine dev`) */
  installer?: PluginInstaller
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

  // The server's admin token reads the metrics too
  const token = values.token ?? env.MAVONENGINE_METRICS_TOKEN ?? env.MAVONENGINE_ADMIN_TOKEN

  return { source: httpSource({ url, token }), clientUrl: new URL('/', url).href, intervalMs, theme: values.theme, transparent: values.transparent }
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
  const view: ViewState = initialViewState()

  const app = await createApp({ fps: 15, theme: readableTheme(options.theme), paintBackground: !options.transparent })

  // Read from GitHub by the dashboard itself, the first time the Plugins tab is shown
  const available = new AvailablePlugins()
  available.onChange(() => app.invalidate())

  const { installer } = options
  installer?.onChange((job) => {
    app.invalidate()
    // The dev servers were just restarted: don't wait out a backoff to notice they are back
    if (job.status === 'done')
      void client.refresh()
  })
  const installable = () => notInProject(available.state.plugins, client.state.plugins.map(plugin => plugin.package))

  app.render(({ ui, theme }) => {
    renderDashboard(ui, theme, client.state, view, {
      available,
      installer,
      transparent: options.transparent,
      startup: options.startup?.(),
      openKey: !!options.clientUrl,
    })

    // The tab changes by key or by mouse, so what was drawn decides. Packets are only fetched for the Network tab
    const watch = showsNetwork(view)
    if (watch && !client.watchNetwork) {
      client.watchNetwork = true
      void client.refresh()
    }
    client.watchNetwork = watch

    // A click or a key picked another packet: load its content
    if ((client.state.packetDetail?.id ?? null) !== view.selectedPacketId)
      void client.inspectPacket(view.selectedPacketId)
  })

  client.onChange(() => app.invalidate())

  const { clientUrl } = options
  if (clientUrl && options.openBrowser) {
    const off = client.onChange(async (state) => {
      if (state.status !== 'live')
        return

      off()
      if (await servesPage(clientUrl))
        openBrowser(clientUrl)
    })
  }

  app.on('key', (event) => {
    // First, so y and n answer the question instead of doing what they otherwise do
    const install = handleInstallKey(view, client.state.plugins, event.key, installable(), installer)
    if (install) {
      if (typeof install === 'string')
        installer!.start([install])
      app.invalidate()
      return
    }

    if (event.key === 'r') {
      void client.refresh()
      // Only once it was shown: a dashboard that never opens the Plugins tab never calls GitHub
      if (available.state.status !== 'idle')
        void available.load(true)
    }

    if (event.key === 'o' && options.clientUrl)
      openBrowser(options.clientUrl)

    const tab = tabForKey(event.key)
    if (tab !== null) {
      view.tab = tab
      app.invalidate()
    }

    if (handlePlayersKey(view, client.state.snapshot, event.key) || handleNetworkKey(view, event.key, client.state.packets) || handlePluginsKey(view, client.state.plugins, event.key, installable()))
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
