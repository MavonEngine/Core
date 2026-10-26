# @mavonengine/cli

Command line tools for [MavonEngine](https://mavonengine.com).

Requires Node 24 or newer.

```sh
npm install -D @mavonengine/cli
npx mavonengine --help
```

## `mavonengine create`

Creates a new project from the multiplayer template, installs its dependencies and starts it like [`mavonengine dev`](#mavonengine-dev). It does the same as `@mavonengine/create-bootstrap`, but in the dashboard.

```sh
npx @mavonengine/cli create my-game
```

Asks for a name if none is given. While the template downloads and `npm install` runs, the startup screen shows each step and its output. Then the dev script starts, and the dashboard takes over as soon as the game server answers. Quitting during setup stops it and leaves what was created so far in the project directory. Without an interactive terminal, or with `--no-dashboard`, the progress and the dev script's output go straight to the terminal.

| Option | Default | |
| --- | --- | --- |
| `--cwd <dir>` | current directory | Where to create the project directory |
| `--no-dashboard` | | Print the progress instead of showing the dashboard |
| `--port <port>` | `8050` | Game server HTTP port for the dashboard |
| `--theme <name>` | `dark` | Dashboard theme |
| `--transparent` | | Let a transparent terminal background show through |

## `mavonengine dev`

Runs the `dev` script of the MavonEngine project you are in and shows the [dashboard](#mavonengine-dashboard) for it. For the multiplayer template that starts the game server and the client together.

While the game server starts, a startup screen shows the latest output of the dev script; the dashboard takes over as soon as the server answers. Quitting the dashboard (`q` or Ctrl-C) stops the dev script and everything it started. If the dev script exits on its own, the dashboard closes and its output is printed.

```sh
npx mavonengine dev

# From somewhere else
npx mavonengine dev --cwd path/to/my-game
```

The project root is the nearest `package.json`, from the current directory upwards, that depends on `@mavonengine/core` and has a `dev` script, so it also works from inside `client/` or `server/`. The package manager comes from the lockfile (`npm`, `pnpm`, `yarn` or `bun`, default `npm`). Without an interactive terminal, or with `--no-dashboard`, the dev script's output goes straight to the terminal instead. Ctrl-C stops everything, and the command exits with the dev script's exit code.

| Option | Default | |
| --- | --- | --- |
| `--cwd <dir>` | current directory | Where to start looking for the project |
| `--no-dashboard` | | Only run the dev script |
| `--port <port>` | `8050` | Game server HTTP port for the dashboard |
| `--theme <name>` | `dark` | Dashboard theme |
| `--transparent` | | Let a transparent terminal background show through |

## `mavonengine dashboard`

A live terminal dashboard for a running game server, built with [hqtui](https://github.com/profullstack/hqtui).

It shows CPU, network bandwidth, tick timings against the tick budget, world/physics/memory stats, the connected players, the server's recent log output and the HTTP requests it received. It reads them from the server's `GET /api/game/metrics`, `GET /api/game/logs` and `GET /api/game/requests` endpoints, which need a `@mavonengine/core` release that includes them.

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

Keys: `q` quits, `r` refreshes now, `1`–`4` switch between the Overview, Players, Logs and HTTP tabs. The mouse wheel scrolls the players table, the logs and the requests; scroll the logs back to the bottom, or the requests back to the top, to follow new ones again.

The HTTP tab lists every request the game server's HTTP server received, newest first: the client (static files or Vite in dev), your own `onHttp` routes, the geckos.io signaling requests and WebSocket upgrades such as Vite's HMR socket, each with status, duration, size and client address. Query strings are left out since they can hold tokens, and the dashboard's own polling is not recorded. The game traffic itself is WebRTC, not HTTP, so it shows on the Players tab instead; with a separate `socketPort` the signaling requests go to that port and don't show up either.

### Server access

The metrics endpoint is configured on the game server:

```ts
const server = new MyServer(logger, physicsWorld, {
  httpPort: 8050,
  metrics: {
    token: process.env.METRICS_TOKEN,
    // Recent log entries kept for the dashboard, 0 turns the logs endpoint off
    logBufferSize: 500,
    // Recent HTTP requests kept for the dashboard, 0 turns the requests endpoint off
    requestLogSize: 500,
  },
})
```

- With no token, the endpoint only answers requests from localhost.
- With `NODE_ENV=production` and no token, the endpoint is turned off.
- Set `metrics.enabled: false` to turn it off everywhere.
- The logs endpoint follows the same rules. It serves whatever passes your logger's level.
