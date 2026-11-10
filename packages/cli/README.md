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


### Installing plugins while it runs

`mavonengine dev` can install packages into the project and restart the dev servers afterwards, so a new plugin is loaded without stopping anything yourself:

- from the dashboard's Plugins tab, with `i` on a plugin that is available to install;
- from the editor's Plugins view, with the Install button of an available plugin, or by typing any package (a name, `name@version`, a `file:` path or a URL) into "Another package".

Both ask first and point at the package's source: installing a package runs its code on your machine, and nothing reviews what you install. The install is the same as [`mavonengine install --yes`](#mavonengine-install), followed by a restart of the dev script.

The editor reaches `mavonengine dev` through the dev server it started (`POST /__mavonengine/plugin-install`), which only takes requests from localhost and from the game's own page, so another site open in the browser can't install anything. Version ranges such as `^1.0.0` and anything with spaces are refused there; use the terminal for those.

## `mavonengine plugins`

Lists the plugins that are available to install.

```sh
npx @mavonengine/cli plugins
```

The list is [`plugins.json`](https://github.com/MavonEngine/Core/blob/main/plugins.json) at the root of the MavonEngine repository, read from the `main` branch on GitHub every time the command runs:

```
https://raw.githubusercontent.com/MavonEngine/Core/main/plugins.json
```

So a plugin shows up as soon as it is added to that file on `main` (GitHub may serve the file a few minutes old). Inside a project the command also says which of the plugins are already in its `mavonengine.json`. `--json` prints the list as JSON, and `--url <url>` or `MAVONENGINE_PLUGINS_URL` reads it from somewhere else, such as a fork or a branch.

To list a plugin, add an entry to `plugins.json`: `package` (the npm name) is required; `name`, `description`, `target` (`client`, `server` or `both`), `engine` (the supported `@mavonengine/core` range), `homepage` and `readme` (the URL of its README as Markdown, such as the raw file on GitHub, which the editor shows) are optional.

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

Keys: `q` quits, `r` refreshes now, `o` opens the game the server serves in the browser, `1`–`7` switch between the Overview, Players, Logs, HTTP, Network, Routes and Plugins tabs. The mouse wheel scrolls the players table, the logs, the requests, the packets and the routes; scroll the logs back to the bottom, or the requests and packets back to the top, to follow new ones again.

The HTTP tab lists every request the game server's HTTP server received, newest first: the client (static files or Vite in dev), your own `onHttp` routes, the geckos.io signaling requests and WebSocket upgrades such as Vite's HMR socket, each with status, duration, size and client address. Query strings are left out since they can hold tokens, and the dashboard's own polling is not recorded. The game traffic itself is WebRTC, not HTTP, so it shows on the Players tab instead; with a separate `socketPort` the signaling requests go to that port and don't show up either.

The Network tab shows the game socket while developing. State sync lists each player with the entities in its last state update, its last acknowledged input and the size and tick of that update (red when it fell behind the others), and counts the synced entities no player is in range of. By message breaks the traffic of the last 5 seconds down by message name and direction: packets per second, average size and bytes per second, the largest share first. Below, every packet and network event, newest first, with its client, size, tick, input sequence id and a few facts about its payload; `p` shows the pings, `e` only the events (`connect`, `disconnect`, `dropped`, `sync_enter`, `sync_leave`). Click a packet, or move through the list with the arrow keys (or `j` / `k`), to see its content next to the list: the payload as it went over the wire, scrolled with the mouse wheel. `esc`, or a second click on it, closes it. The server drops the payloads of old packets to bound its memory, so only recent ones can be opened. The packets are only fetched while the tab shows, and only a server that is not running in production records them, see the [network tools](#mavonengine-mcp).

The Routes tab lists every HTTP endpoint the server has: the engine's own, the ones your server registered in `onHttp` and those of plugins, each with its method, path, whether it only exists in development or is served in production too, where it comes from and what it does. The list is read from the running server, so a new route shows up without being declared anywhere; say what it does with `describeRoute()` from `@mavonengine/core/Networking/Server/Http/RouteCatalog`, and pass it `devOnly: true` for a route you only register in development, since a route that doesn't say is listed as `prod + dev`. It needs a server on a `@mavonengine/core` release with `GET /api/game/routes`.

The Plugins tab lists the plugins in the project's `mavonengine.json` with their version, whether they are enabled, where they run and how many endpoints and prefabs they have. `↑`/`↓` (or `j`/`k`, or a click) pick one to see its description, supported engine versions, license, prefabs and the HTTP endpoints it registered. A server plugin that is enabled but not running in this server shows as `not loaded`. It needs a server on a `@mavonengine/core` release with `GET /api/game/plugins`.

Below it, "Available to install" lists the plugins from [`mavonengine plugins`](#mavonengine-plugins) that the project doesn't have yet. The dashboard reads that list from GitHub itself, the first time the tab is shown and again on `r`; a dashboard that never opens the tab never asks for it.

Under [`mavonengine dev`](#mavonengine-dev) a plugin from that list can be installed right there: select it with `↓` and press `i`. The dashboard first asks whether you checked its source, because installing a package runs its code on your machine; `y` installs it with the project's package manager, adds it to `mavonengine.json` and restarts the dev servers, `n` cancels. A dashboard started on its own with `mavonengine dashboard` only shows the command, since it can't restart servers it didn't start.

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

## `mavonengine mcp`

A [Model Context Protocol](https://modelcontextprotocol.io) server over stdio, so an AI coding assistant can look at your running game: the game server, and the game tabs open in a browser. It works with any MCP client and any model: Claude Code, Cursor, VS Code, Codex, Gemini CLI, Zed, or a local model behind an MCP-capable client.

Projects made with `mavonengine create` get a `.mcp.json` that registers it. Elsewhere, add it to your client as a stdio server; most clients take this JSON:

```json
{
  "mcpServers": {
    "mavonengine": { "command": "npx", "args": ["-y", "@mavonengine/cli", "mcp"] }
  }
}
```

Game server tools:

| Tool | |
| --- | --- |
| `server_status` | Uptime, tick time against its budget, CPU, bandwidth, memory, player / entity / physics counts |
| `server_metrics` | The full metrics snapshot, optionally with its per-second history |
| `list_players` | Connected players with position and connection details |
| `get_scene` | The active scene: file, hot reload, unsaved changes, settings and objects (dev only) |
| `list_entities` | Entities in the world, filtered by type and distance to a point (dev only) |
| `get_entity` | One entity with the state it sends to clients (dev only) |
| `recent_logs` | Server log lines, filtered by level and text |
| `recent_requests` | HTTP requests the server answered, filtered by path and status |
| `network_packets` / `network_packet` | Packets the server sent and received and its network events, per client: size, tick, input sequence id; and one packet with its payload (dev only) |
| `network_sync` | Who is sent what: each player's tracked entities and last state update, and by how many players each entity is tracked (dev only) |

Client tools, for the game tabs open while Vite serves the client in dev:

| Tool | |
| --- | --- |
| `list_clients` | Open tabs: page, editor or player, the player's id on the server, visibility, FPS |
| `client_status` | Draw calls and triangles of one frame, GPU geometries / textures / programs, JS heap, canvas, camera |
| `client_entities` / `client_entity` | The tab's world, in the same shape as the server's, with its local player marked |
| `client_scene` | The scene loaded in the tab, and which objects the client built |
| `client_network` | Connection, ping, inputs sent but not yet acknowledged by the server, and the last state update: its server tick, ack and age |
| `client_packets` / `client_packet` | Packets the tab sent and received and its network events, and one packet with its payload |
| `network_timeline` | The server's records for one tab and the tab's own, merged by time |
| `client_logs` | Console output, uncaught errors and unhandled rejections, filtered by level and text |
| `client_screenshot` | What the tab renders, as an image (the WebGL canvas, without HTML UI) |
| `client_trace` | Records a few seconds of the tab and analyses it: frame times, render CPU vs GPU, composer passes, ticks, WebGL work per frame, the bottleneck, and the worst hitches with their causes. Saves a flame chart trace file |
| `compare_entity` | One entity on the server next to a tab's copy: position / rotation / scale deltas and differing fields |

Documentation tools, passed through to the MCP server of [mavonengine.com](https://mavonengine.com) (`https://mavonengine.com/mcp`), so answers come from the current docs:

| Tool | |
| --- | --- |
| `docs_list_pages` | Every docs page with its path, title, description and category |
| `docs_get_page` | One docs page as Markdown, by path (e.g. `/networking/state-sync`) |

They connect to the site the first time one is used, so the other tools also work offline. `--docs-url` points them at another docs server, `--no-docs` leaves them out.

Client tools take a `clientId` from `list_clients`. Without one they ask the only open tab, or the only one not running the editor.

Every tool is read-only. It takes `--host`, `--port`, `--url` and `--token` like the dashboard, where `--url` is the server's base URL (`http://localhost:8050`). When Vite serves the client on its own port instead of through the game server, pass `--client-url`, e.g. `http://localhost:5173`.

The server scene and entity tools read `GET /api/game/dev/*` on the game server. Those routes are only registered when `NODE_ENV` is not `production`: a metrics token does not turn them on there. Otherwise they follow the [server access](#server-access) rules of the metrics endpoint.

The client tools go through the dev bridge of the Vite plugin in `@mavonengine/core/vite.config` (Vite 8). In dev it adds a small module to the page that answers over Vite's hot-reload WebSocket, and serves `GET /__mavonengine/clients` to localhost, or with `MAVONENGINE_METRICS_TOKEN` as bearer token when that is set for the dev server. Builds never include it. Turn it off with `mavonEnginePlugins({ devBridge: false })`.

`client_trace` patches the tab only while it records and puts everything back afterwards. It times every frame and composer pass, counts the WebGL calls on the context, keeps slow single calls (shader compiles, texture uploads, `readPixels` / `getError` stalls), long animation frames with the scripts that ran, and your own `performance.measure()` spans. GPU time per frame needs `EXT_disjoint_timer_query_webgl2` (Chrome and Edge on most GPUs; the three-perf panel pauses while tracing since it uses the same queries). JS call stacks come from the [JS Self-Profiling API](https://wicg.github.io/js-self-profiling/) in Chromium browsers: the Vite plugin serves dev pages with `Document-Policy: js-profiling` for it, so reload tabs opened before you updated. The trace file is [Chrome Trace Event](https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU) JSON with tracks for frames, passes, GPU time, ticks, JS samples and slow WebGL calls: open it in [Perfetto](https://ui.perfetto.dev), `chrome://tracing` or [speedscope](https://www.speedscope.app). Keep the tab in the foreground while it records, browsers throttle hidden tabs.

The network tools read what both sides record while developing: every message through the game socket, the engine's and your own, with its size, and events such as `connect`, `disconnect`, `dropped` (the transport dropped a message), `sync_enter` / `sync_leave` (entities coming into or leaving a player's sync distance) and, on a client, `state_gap` (state updates that never arrived) and `state_out_of_order`. Each side keeps its last 2000 records, and 8 MB of their payloads. The server records when `NODE_ENV` is not `production` and serves them on `GET /api/game/dev/net/packets`, `/packets/:id` and `/sync`; a tab records while the dev bridge or the editor runs. Nothing is recorded, and the socket is left untouched, in a production build. `network_timeline` orders the two sides by their own clocks, which line up on one machine.

To let `compare_entity` match your own player with the server's, set `game.localPlayer` to the entity the tab controls, or give it `isLocalPlayer = true`: the server keys players by socket id, which the client often doesn't.

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
