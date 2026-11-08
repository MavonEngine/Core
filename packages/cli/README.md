# @mavonengine/cli

Command line tools for [MavonEngine](https://mavonengine.com).

Requires Node 24 or newer.

```sh
npm install -D @mavonengine/cli
npx @mavonengine/cli --help
```

## `mavonengine create`

Creates a new project from the multiplayer template, installs its dependencies and starts it like [`mavonengine dev`](#mavonengine-dev). It replaces `@mavonengine/create-bootstrap`, which now forwards to it.

```sh
npx @mavonengine/cli create my-game
```

Asks for a name if none is given. While the template downloads and `npm install` runs, the startup screen shows each step and its output. Then the dev script starts, the dashboard takes over as soon as the game server answers, and the game opens in the browser. Quitting during setup stops it and leaves what was created so far in the project directory. Without an interactive terminal, or with `--no-dashboard`, the progress and the dev script's output go straight to the terminal.

| Option | Default | |
| --- | --- | --- |
| `--cwd <dir>` | current directory | Where to create the project directory |
| `--no-dashboard` | | Print the progress instead of showing the dashboard |
| `--port <port>` | `8050` | Game server HTTP port for the dashboard |
| `--theme <name>` | `dark` | Dashboard theme |
| `--transparent` | | Let a transparent terminal background show through |
| `--no-open` | | Don't open the game in the browser once the server is up |

## `mavonengine dev`

Runs the dev script of the MavonEngine project you are in and shows the [dashboard](#mavonengine-dashboard) for it. For the multiplayer template that starts the game server and the client together.

It runs the project's `dev:server` script, or `dev` when there is none. So `dev` can be `mavonengine dev` itself, as in the multiplayer template, and `npm run dev` brings up the dashboard. A `dev` script that would start `mavonengine dev` again, without a `dev:server` next to it, is refused instead of looping.

While the game server starts, a startup screen shows the latest output of the dev script; the dashboard takes over as soon as the server answers. Once the server is up, the game it serves opens in your default browser (not over SSH, and only if the server answers `/` with a page); `--no-open` turns that off, and `o` opens it again any time. Quitting the dashboard (`q` or Ctrl-C) stops the dev script and everything it started. If the dev script exits on its own, the dashboard closes and its output is printed.

```sh
npx @mavonengine/cli dev

# From somewhere else
npx @mavonengine/cli dev --cwd path/to/my-game
```

The project root is the nearest `package.json`, from the current directory upwards, that depends on `@mavonengine/core` and has a `dev` script, so it also works from inside `client/` or `server/`. The package manager comes from the lockfile (`npm`, `pnpm`, `yarn` or `bun`, default `npm`). Without an interactive terminal, or with `--no-dashboard`, the dev script's output goes straight to the terminal instead. Ctrl-C stops everything, and the command exits with the dev script's exit code.

| Option | Default | |
| --- | --- | --- |
| `--cwd <dir>` | current directory | Where to start looking for the project |
| `--no-dashboard` | | Only run the dev script |
| `--port <port>` | `8050` | Game server HTTP port for the dashboard |
| `--theme <name>` | `dark` | Dashboard theme |
| `--transparent` | | Let a transparent terminal background show through |
| `--no-open` | | Don't open the game in the browser once the server is up |

## `mavonengine install`

Installs packages into the project you are in, with its package manager. For each one that is a MavonEngine [plugin](#writing-a-plugin), it shows where the plugin runs (client, server or both) and which prefabs it brings, and asks whether to add it to the `plugins` in `mavonengine.json`. Registered plugins load on the client and/or the game server and are built into the release.

```sh
npx @mavonengine/cli install my-custom-plugin

# Anything your package manager takes
npx @mavonengine/cli install @acme/forest@^2 file:../my-plugin --yes
```

`mavonengine.json` sits in the project root, next to `package.json`, and is created if it doesn't exist:

```json
{
  "plugins": {
    "my-custom-plugin": { "enabled": true, "prefabs": ["Tree"], "options": { "density": 2 } }
  }
}
```

- `enabled`: set to `false` to turn a plugin off without uninstalling it.
- `prefabs`: the plugin prefabs the project uses. The editor adds a prefab here when you place it, and you can edit the list by hand. Only the assets of these prefabs (plus the plugin's shared assets) go into the release.
- `options`: passed to the plugin as `ctx.options`.

The client reloads when the plugins in `mavonengine.json` change. Restart the game server to load a new server plugin. Without an interactive terminal it only installs, unless `--yes` is given.

| Option | Default | |
| --- | --- | --- |
| `--cwd <dir>` | current directory | Where to start looking for the project |
| `-y`, `--yes` | | Add plugins to `mavonengine.json` without asking |
| `--no-register` | | Only install |

## `mavonengine build`

Runs the project's `build` script, then lists what each plugin put into the release. Plugin assets are copied into the client's output under `plugins/<package>/`. Only the shared ones and those of the prefabs in `mavonengine.json` are copied. The client skips loading the others, so a release never requests a file it doesn't contain.

```sh
npx @mavonengine/cli build
```

| Option | Default | |
| --- | --- | --- |
| `--cwd <dir>` | current directory | Where to start looking for the project |

## `mavonengine dashboard`

A live terminal dashboard for a running game server, built with [hqtui](https://github.com/profullstack/hqtui). For the same dashboard in a browser, behind a login, see the [`@mavonengine/http-monitoring`](https://github.com/MavonEngine/Core/tree/main/packages/plugins/http-monitoring) plugin.

It shows CPU, network bandwidth, tick timings against the tick budget, world/physics/memory stats, the connected players, the server's recent log output and the HTTP requests it received. It reads them from the server's `GET /api/game/metrics`, `GET /api/game/logs` and `GET /api/game/requests` endpoints, which need a `@mavonengine/core` release that includes them.

```sh
# Local server on the default HTTP port (8050)
npx @mavonengine/cli dashboard

# Remote server with a metrics token
MAVONENGINE_METRICS_TOKEN=secret npx @mavonengine/cli dashboard --host game.example.com --port 8050

# No server needed: simulated data
npx @mavonengine/cli dashboard --sim
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

Keys: `q` quits, `r` refreshes now, `o` opens the game the server serves in the browser, `1`–`4` switch between the Overview, Players, Logs and HTTP tabs. The mouse wheel scrolls the players table, the logs and the requests; scroll the logs back to the bottom, or the requests back to the top, to follow new ones again.

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

## Writing a plugin

A plugin is an npm package with a `mavonengine` field in its `package.json`:

```json
{
  "name": "my-custom-plugin",
  "type": "module",
  "mavonengine": {
    "target": "both",
    "client": "./dist/client.js",
    "server": "./dist/server.js",
    "engine": "^0.0.22",
    "assets": {
      "dir": "./assets",
      "shared": ["textures/bark.png"],
      "prefabs": {
        "Tree": ["models/tree.glb"],
        "Rock": ["models/rock.glb"]
      }
    }
  }
}
```

- `target`: `client`, `server` or `both`. The matching entries are required.
- `assets`: paths relative to `dir` (default `assets`). They are served at `/plugins/<package>/<path>`: all of them in dev, and only the shared ones and those of used prefabs in a release.

Each entry default-exports the plugin. Every hook gets the plugin's context last, which carries `package`, `options`, `game` and `logger`.

```ts
// client.ts
import { defineClientPlugin } from '@mavonengine/core/Plugins/types'

export default defineClientPlugin({
  assets: ctx => [{ name: 'tree', type: 'gltfModel', path: ctx.assetUrl('models/tree.glb') }],
  setup(ctx) {
    ctx.registerPrefab({
      name: 'Tree',
      spawn: position => ({ object: new Tree(position) }),
    })
  },
  update(delta, ctx) {},
  // Dev only, when the editor boots
  editor(ctx) {
    ctx.editor.on('objectSelected', () => {})
  },
})
```

```ts
// server.ts
import { defineServerPlugin } from '@mavonengine/core/Plugins/types'

export default defineServerPlugin({
  setup(ctx) {},
  // Runs after the server's own onHttp routes, before the game client
  http(app, ctx) {
    app.get('/api/my-plugin/status', (_req, res) => res.json({ ok: true }))
  },
  onConnection(channel, client, ctx) {},
  onDisconnect(channel, ctx) {},
  tick(delta, ctx) {},
  destroy(ctx) {},
})
```

A hook that throws is logged and turned off for that plugin, and the game keeps running.

Projects made with `mavonengine create` are already set up for plugins. To set up an existing project:

```ts
// client: Game.usePlugins() before new Game()
import Game from '@mavonengine/core/Game'
import plugins from 'virtual:mavonengine/plugins'

Game.usePlugins(plugins)
```

```ts
// server: the directory with mavonengine.json
const server = new MyServer(logger, physicsWorld, { plugins: { root: projectRoot } })
await server.start()
```

The client's Vite config needs to extend `@mavonengine/core/vite.config`, which provides `virtual:mavonengine/plugins`, serves plugin assets in dev and copies them into the release.
