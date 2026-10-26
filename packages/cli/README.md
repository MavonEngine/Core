# @mavonengine/cli

Command line tools for [MavonEngine](https://mavonengine.com).

Requires Node 24 or newer.

```sh
npm install -D @mavonengine/cli
npx mavonengine --help
```

## `mavonengine dev`

Runs the `dev` script of the MavonEngine project you are in. For the multiplayer template that starts the game server and the client together.

```sh
npx mavonengine dev

# From somewhere else
npx mavonengine dev --cwd path/to/my-game
```

The project root is the nearest `package.json`, from the current directory upwards, that depends on `@mavonengine/core` and has a `dev` script, so it also works from inside `client/` or `server/`. The package manager comes from the lockfile (`npm`, `pnpm`, `yarn` or `bun`, default `npm`). Ctrl-C stops everything, and the command exits with the dev script's exit code.

| Option | Default | |
| --- | --- | --- |
| `--cwd <dir>` | current directory | Where to start looking for the project |

## `mavonengine dashboard`

A live terminal dashboard for a running game server, built with [hqtui](https://github.com/profullstack/hqtui).

It shows CPU, network bandwidth, tick timings against the tick budget, world/physics/memory stats, the connected players and the server's recent log output. It reads them from the server's `GET /api/game/metrics` and `GET /api/game/logs` endpoints, which need a `@mavonengine/core` release that includes them.

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
| `--transparent` | | Let a transparent terminal background show through. Text can be hard to read over a light wallpaper |
| `--sim` | | Simulated data instead of a server |

Keys: `q` quits, `r` refreshes now. The mouse wheel scrolls the players table and the logs; scroll the logs back to the bottom to follow new lines again.

### Server access

The metrics endpoint is configured on the game server:

```ts
const server = new MyServer(logger, physicsWorld, {
  httpPort: 8050,
  metrics: {
    token: process.env.METRICS_TOKEN,
    // Recent log entries kept for the dashboard, 0 turns the logs endpoint off
    logBufferSize: 500,
  },
})
```

- With no token, the endpoint only answers requests from localhost.
- With `NODE_ENV=production` and no token, the endpoint is turned off.
- Set `metrics.enabled: false` to turn it off everywhere.
- The logs endpoint follows the same rules. It serves whatever passes your logger's level.
