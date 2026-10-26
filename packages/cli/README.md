# @mavonengine/cli

Command line tools for [MavonEngine](https://mavonengine.com).

Requires Node 22.6 or newer.

```sh
npm install -D @mavonengine/cli
npx mavonengine --help
```

## `mavonengine dashboard`

A live terminal dashboard for a running game server, built with [hqtui](https://github.com/profullstack/hqtui).

It shows CPU, network bandwidth, tick timings against the tick budget, world/physics/memory stats and the connected players. It reads them from the server's `GET /api/game/metrics` endpoint, which needs a `@mavonengine/core` release that includes it.

```sh
# Local server on the default HTTP port (8050)
npx mavonengine dashboard

# Remote server with a metrics token
MAVONENGINE_METRICS_TOKEN=secret npx mavonengine dashboard --host game.example.com --port 8050

# No server needed: simulated data
npx mavonengine dashboard --sim
```

| Option | Default | |
| --- | --- | --- |
| `--host <host>` | `localhost` | Server host |
| `--port <port>` | `8050` | Server HTTP port (`ServerOptions.httpPort`) |
| `--url <url>` | | Full metrics URL, overrides `--host` and `--port` |
| `--token <token>` | `$MAVONENGINE_METRICS_TOKEN` | Metrics token (`ServerOptions.metrics.token`) |
| `--interval <ms>` | `1000` | Poll interval |
| `--theme <name>` | `dark` | `dark`, `dracula`, `nord`, `tokyoNight`, `gruvbox`, `matrix`, `monochrome`, `highContrast`, `light` |
| `--sim` | | Simulated data instead of a server |

Keys: `q` quits, `r` refreshes now, and the mouse wheel scrolls the players table.

### Server access

The metrics endpoint is configured on the game server:

```ts
const server = new MyServer(logger, physicsWorld, {
  httpPort: 8050,
  metrics: {
    token: process.env.METRICS_TOKEN,
  },
})
```

- With no token, the endpoint only answers requests from localhost.
- With `NODE_ENV=production` and no token, the endpoint is turned off.
- Set `metrics.enabled: false` to turn it off everywhere.
