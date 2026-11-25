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

Next to `plugins`, the file says what goes for the whole project:

- `appUrl`: where the game is, like `https://mygame.com`. Links that leave the game, such as those in mails, point there. Server plugins get it as `ctx.appUrl`. `MAVONENGINE_APP_URL` overrides it, for example per deployment.
- `appName`: the game's name, in mails and in the browser tab: `%MAVONENGINE_APP_NAME%` in the client's `index.html` becomes it, in dev and in the build (`MavonEngine` without one). Server plugins get it as `ctx.appName`.
- `database`, `auth`, `notifications`: which plugin to use when more than one of that kind is enabled.

The client reloads when the plugins in `mavonengine.json` change. Restart the game server to load a new server plugin. Without an interactive terminal it only installs, unless `--yes` is given.

| Option | Default | |
| --- | --- | --- |
| `--cwd <dir>` | current directory | Where to start looking for the project |
| `-y`, `--yes` | | Add plugins to `mavonengine.json` without asking |
| `--no-register` | | Only install |

## `mavonengine asset:publish`

Copies the files a plugin lets you change into your project, such as the mail plugin's layout:

```sh
npx @mavonengine/cli asset:publish @mavonengine/mail
```

They go to `resources/<package>/`, here `resources/@mavonengine/mail/layout.html`. The plugin uses your copy from then on, so change it there and commit it. Files you have already are kept, so publishing again after an update only adds the plugin's new files. `--force` replaces yours with the plugin's.

A plugin offers files with `"publish": "<directory>"` under `mavonengine` in its `package.json`, and finds your copy with `ctx.publishedFile('<file>')`.

| Option | Default | |
| --- | --- | --- |
| `--cwd <dir>` | current directory | Where to start looking for the project |
| `--force` | | Replace the files you have with the plugin's |

## `mavonengine make:plugin`

Creates a plugin inside the project you are in, ready to load:

```sh
npx @mavonengine/cli make:plugin forest
npx @mavonengine/cli make:plugin @acme/forest --target server
```

It writes `plugins/<name>/` (without the scope) with a `package.json` that has the [`mavonengine` manifest](#writing-a-plugin), `src/client.ts` and/or `src/server.ts` with every hook stubbed, a `tsconfig.json` and a README. Then it adds `plugins/*` to the `workspaces` in `package.json` (pnpm gets a `link:` dependency instead), adds the plugin to `mavonengine.json` and runs the package manager's install, which links it into `node_modules`.

The manifest points at the TypeScript sources, so there is no build step: Vite compiles the client entry and Node 24 strips the types of the server entry. That means the server entry takes only syntax Node can strip (no `enum`s or parameter properties) and imports its own files with `.ts` extensions, which the generated `tsconfig.json` enforces. The client reloads when its entry changes; restart the game server for changes to the server entry. To publish the plugin to npm later, build it to `dist/` like the [first-party plugins](https://github.com/MavonEngine/Core/tree/main/packages/plugins) and point the manifest there.

It refuses a name that is already in `mavonengine.json`, installed, or a directory that exists, and never overwrites a file.

| Option | Default | |
| --- | --- | --- |
| `--target <side>` | `both` | `client`, `server` or `both` |
| `--cwd <dir>` | current directory | Where to start looking for the project |
| `--no-register` | | Leave `mavonengine.json` alone |
| `--no-install` | | Don't run the package manager to link it |

## `mavonengine build`

Runs the project's `build` script, then lists what each plugin put into the release. Plugin assets are copied into the client's output under `plugins/<package>/`. Only the shared ones and those of the prefabs in `mavonengine.json` are copied. The client skips loading the others, so a release never requests a file it doesn't contain.

```sh
npx @mavonengine/cli build
```

| Option | Default | |
| --- | --- | --- |
| `--cwd <dir>` | current directory | Where to start looking for the project |

## `mavonengine doctor`

Checks the project you are in and says what to do about what it finds. It changes nothing.

```sh
npx @mavonengine/cli doctor
```

```
MavonEngine project at ~/games/my-game (npm, @mavonengine/core 0.0.25)

Environment
  ✓ Node 24.4.0                 needs >=24
  ✓ @mavonengine/cli 0.0.6
  i @mavonengine/core 0.0.25    0.0.26 is out

mavonengine.json
  ✓ mavonengine.json  2 plugins
  ✗ appUrl "mygame.com"         is not an http(s) URL
      → e.g. "appUrl": "https://mygame.com"

Plugins
  ✓ @mavonengine/chat 0.0.3     core >=0.0.22
  ✗ @mavonengine/auth 0.2.0     made for @mavonengine/core >=0.0.26, the project has 0.0.25
      → mavonengine install @mavonengine/auth@0.1.1

2 errors, 0 warnings
```

- **Environment**: the Node version, against what the CLI and the installed `@mavonengine/core` need. Then each `@mavonengine/*` package in `package.json`: whether it is installed and matches the range there (or `npm install` is due), and whether a newer one is out.
- **mavonengine.json**: whether it can be read, an `appUrl` that isn't an http(s) URL, a `database`, `auth` or `notifications` that names a plugin that isn't in `plugins` or is turned off, entries of the wrong shape, and settings it doesn't know (typos).
- **Migrations**: the [`upgrade`](#mavonengine-upgrade) migrations the project's core has that the project hasn't had yet.
- **Plugins**: each plugin in `mavonengine.json` must be installed, a MavonEngine plugin, and built (its entries exist). It also needs the assets of the prefabs in use, and has to be made for the project's core. A plugin's supported core is `engine` in its `mavonengine` field, or else its `@mavonengine/core` peer dependency. When a plugin doesn't fit, doctor looks through the versions published on npm for the newest one that does and names it. A plugin that is installed but not in `mavonengine.json` is pointed out too.

The game server and the Vite plugin also check `engine` when they load plugins. A plugin made for another core still loads, with a warning that points here.

Version lookups go to the npm registry (`npm_config_registry` when set, else registry.npmjs.org) and send it the names of the project's `@mavonengine/*` packages and plugins. `--offline` leaves that out. When the registry can't be reached, that is one warning and the rest is checked anyway.

The exit code is 1 when something is wrong (✗), 0 otherwise. With `--strict` warnings (!) fail too, notes (i) never do. `--json` prints the findings for CI and scripts.

| Option | Default | |
| --- | --- | --- |
| `--offline` | | Don't ask the npm registry |
| `--strict` | | Fail on warnings too |
| `--json` | | Print the findings as JSON |
| `--cwd <dir>` | current directory | Where to start looking for the project |

## `mavonengine upgrade`

Moves the project to the latest `@mavonengine/core`, with plugins that work with it, then makes the changes to the project's files that the new core needs.

```sh
npx @mavonengine/cli upgrade --dry-run   # see what would happen
npx @mavonengine/cli upgrade
```

1. **Packages.** `@mavonengine/core` goes to its latest version on the npm registry, or to `--to <version>`. Each plugin goes to its newest version whose `engine` range takes that core. The other `@mavonengine/*` packages go to their newest version whose `@mavonengine/core` peer range takes it. Packages are never moved down, and packages from `file:`, git or another source are left alone. When a plugin has no version for the new core, the upgrade stops before installing anything: pick an older core with `--to`, remove the plugin, or pass `--force`. The packages are installed with the project's package manager. Each stays in `dependencies` or `devDependencies`, and pinned versions stay pinned.
2. **Migrations.** These come from the core that is now installed, so the new core decides what to migrate. Each one is shown as a diff before anything is written. Applied migrations are recorded in `migrations` in `mavonengine.json` and never offered again, even when you undo one on purpose. When a migration adds a dependency, the package manager installs it.
3. **Doctor.** [`mavonengine doctor`](#mavonengine-doctor) checks the result, and the exit code is doctor's.

| Migration | What it changes |
| --- | --- |
| `0.0.22-dev-script` | `npm run dev` starts `mavonengine dev`. The old `dev` script becomes `dev:server`, and `@mavonengine/cli` becomes a dev dependency |
| `0.0.25-app-name-title` | `index.html`'s `<title>` becomes `%MAVONENGINE_APP_NAME%`. The title it had becomes `appName` in `mavonengine.json`, so the tab still says the same |

The upgrade asks before installing and before writing; `--yes` skips both questions, and without a terminal `--yes` is required. It won't start with uncommitted changes in git, so its changes can be reviewed and undone on their own; `--allow-dirty` overrides that. After installing packages yourself, `--only-migrations` runs only steps 2 and 3.

| Option | Default | |
| --- | --- | --- |
| `--to <version>` | latest | The `@mavonengine/core` version to move to |
| `--only-migrations` | | Leave the packages alone |
| `--dry-run` | | Show what would happen, change nothing |
| `-y`, `--yes` | | Don't ask |
| `--force` | | Upgrade even when a plugin has no version for the new core |
| `--allow-dirty` | | Start with uncommitted changes |
| `--cwd <dir>` | current directory | Where to start looking for the project |

### Writing a migration

Migrations are in `packages/core/src/Migrations/migrations.ts`, oldest first. Each has an `id` of `<since>-<name>` that never changes once released, the first core version it is for (`since`), and a one-line `description`. `applies` says whether the project still needs it, and `run` changes the project. Both read and write only through `ctx.files`, so the change can be shown before it is written. A migration must leave a project it has already run on alone.

A CI check (`.github/workflows/migrations.yml`, running `scripts/check-migrations.mjs`) asks for a migration when a pull request changes the multiplayer template's project files. It watches the `package.json` files (scripts, workspaces, and which dependencies there are, but not their versions, which every release bumps), the config files and `client/index.html`. Game code, the README and the lockfile don't count. The check passes when the pull request adds a migration, or when its description says `[no migration]` because existing projects don't need the change.

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
| `--token <token>` | `$MAVONENGINE_METRICS_TOKEN`, then `$MAVONENGINE_ADMIN_TOKEN` | Metrics token (`ServerOptions.metrics.token`), or the server's [admin token](#admin-token) |
| `--interval <ms>` | `1000` | Poll interval |
| `--theme <name>` | `dark` | `dark`, `dracula`, `nord`, `tokyoNight`, `gruvbox`, `matrix`, `monochrome`, `highContrast`, `light` |
| `--transparent` | | Let a transparent terminal background show through. Text can be hard to read over a light wallpaper |
| `--sim` | | Simulated data instead of a server |

Keys: `q` quits, `r` refreshes now, `o` opens the game the server serves in the browser, `1`–`7` switch between the Overview, Players, Logs, HTTP, Network, Routes and Plugins tabs, and `8` to the Database tab when the server has a database plugin. The mouse wheel scrolls the players table, the logs, the requests, the packets and the routes; scroll the logs back to the bottom, or the requests and packets back to the top, to follow new ones again.

The HTTP tab lists every request the game server's HTTP server received, newest first: the client (static files or Vite in dev), your own `onHttp` routes, the geckos.io signaling requests and WebSocket upgrades such as Vite's HMR socket, each with status, duration, size and client address. Query strings are left out since they can hold tokens, and the dashboard's own polling is not recorded. The game traffic itself is WebRTC, not HTTP, so it shows on the Players tab instead; with a separate `socketPort` the signaling requests go to that port and don't show up either.

The Network tab shows the game socket while developing. State sync lists each player with the entities in its last state update, its last acknowledged input and the size and tick of that update (red when it fell behind the others), and counts the synced entities no player is in range of. By message breaks the traffic of the last 5 seconds down by message name and direction: packets per second, average size and bytes per second, the largest share first. Below, every packet and network event, newest first, with its client, size, tick, input sequence id and a few facts about its payload; `p` shows the pings, `e` only the events (`connect`, `disconnect`, `dropped`, `sync_enter`, `sync_leave`). Click a packet, or move through the list with the arrow keys (or `j` / `k`), to see its content next to the list: the payload as it went over the wire, scrolled with the mouse wheel. `esc`, or a second click on it, closes it. The server drops the payloads of old packets to bound its memory, so only recent ones can be opened. The packets are only fetched while the tab shows, and only a server that is not running in production records them, see the [network tools](#mavonengine-mcp).

The Routes tab lists every HTTP endpoint the server has: the engine's own, the ones your server registered in `onHttp` and those of plugins, each with its method, path, whether it only exists in development or is served in production too, where it comes from and what it does. The list is read from the running server, so a new route shows up without being declared anywhere; say what it does with `describeRoute()` from `@mavonengine/core/Networking/Server/Http/RouteCatalog`, and pass it `devOnly: true` for a route you only register in development, since a route that doesn't say is listed as `prod + dev`. It needs a server on a `@mavonengine/core` release with `GET /api/game/routes`.

The Plugins tab lists the plugins in the project's `mavonengine.json` with their version, whether they are enabled, where they run and how many endpoints and prefabs they have. `↑`/`↓` (or `j`/`k`, or a click) pick one to see its description, supported engine versions, license, prefabs and the HTTP endpoints it registered. A server plugin that is enabled but not running in this server shows as `not loaded`. It needs a server on a `@mavonengine/core` release with `GET /api/game/plugins`.

Below it, "Available to install" lists the plugins from [`mavonengine plugins`](#mavonengine-plugins) that the project doesn't have yet. The dashboard reads that list from GitHub itself, the first time the tab is shown and again on `r`; a dashboard that never opens the tab never asks for it.

The Database tab looks into the server's database. It only shows up when the server runs a database plugin such as [`@mavonengine/sqlite`](https://github.com/MavonEngine/Core/tree/main/packages/plugins/sqlite), which it marks in `GET /api/game/plugins`. It lists the tables with the plugin each belongs to (by its table prefix, `game` for the rest) and their number of rows, shows the rows of the selected table and, below, the migrations each plugin ran. `↑`/`↓` (or `j`/`k`, or a click) pick a table, `←`/`→` (or page up / page down) page through its rows. It only reads, and only while the tab shows, every 5 seconds. The database holds what players did, so the server only shows it with its admin token: start the dashboard with `--token <admin token>` for a server that has one; without one it only answers on the server's own machine. It needs a server on a `@mavonengine/core` release with `GET /api/game/database`.

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
- The server's [admin token](#admin-token) is taken as well, and turns the endpoint on in production by itself.
- Set `metrics.enabled: false` to turn it off everywhere.
- The logs endpoint follows the same rules. It serves whatever passes your logger's level.

### Admin token

A game server has one admin token, for everything that changes it or tells what not everyone should know. The engine and every plugin use the same one, so no plugin needs a secret of its own:

```sh
MAVONENGINE_ADMIN_TOKEN=… npm start
```

or `adminToken` in the server's options. Requests send it as `Authorization: Bearer <token>`. Without a token, admin routes only answer requests from localhost.

- It also reads the metrics, so the dashboard and `mavonengine mcp` take it for `--token`. The metrics token stays read-only: it administers nothing.
- [`@mavonengine/chat`](../plugins/chat) guards its admin API with it, and [`@mavonengine/http-monitoring`](../plugins/http-monitoring) takes it as the password of its login.
- The Routes tab shows which routes ask for it.

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

Plugin tools:

| Tool | |
| --- | --- |
| `list_plugins` | The plugins in the project's `mavonengine.json`: version, whether each is enabled and runs on the server, its prefabs and the HTTP endpoints it registered |
| `available_plugins` | The official plugins from [`mavonengine plugins`](#mavonengine-plugins): what each does, where it runs, the command that installs it, and whether the project already has it |
| `plugin_readme` | The README of one of them as Markdown: its options, how a game hooks into it and its limits |

With these an assistant can suggest a plugin instead of building what one already does, and set it up from its readme. It can't install one: these tools are read-only, so it hands you the command. `available_plugins` and `plugin_readme` read the list and the readmes from GitHub when they are used; `--plugins-url` or `MAVONENGINE_PLUGINS_URL` points them at another list and `--no-plugin-list` leaves them out.

Database tools, for the project's database plugin such as [`@mavonengine/sqlite`](https://github.com/MavonEngine/Core/tree/main/packages/plugins/sqlite):

| Tool | |
| --- | --- |
| `database_overview` | Which plugin gives the database, every table with the plugin it belongs to, its columns and row count, and the migrations each plugin ran |
| `database_rows` | A page of one table's rows, with the total |

They read through the server's `GET /api/game/database` endpoints, so they work with any database plugin and only read. Like the dashboard's Database tab they need the server's [admin token](#admin-token) as `--token`, unless the server runs on the same machine without one. What a tool returns goes to the assistant's model, so `database_rows` replaces the values of columns that look secret, such as password and session token hashes, with `[redacted]` and lists them in `redacted`.

Documentation tools, passed through to the MCP server of [mavonengine.com](https://mavonengine.com) (`https://mavonengine.com/mcp`), so answers come from the current docs:

| Tool | |
| --- | --- |
| `docs_list_pages` | Every docs page with its path, title, description and category |
| `docs_get_page` | One docs page as Markdown, by path (e.g. `/networking/state-sync`) |

They connect to the site the first time one is used, so the other tools also work offline. `--docs-url` points them at another docs server, `--no-docs` leaves them out.

Client tools take a `clientId` from `list_clients`. Without one they ask the only open tab, or the only one not running the editor.

Tools from your project's plugins, while the client's dev server runs:

| Tool | |
| --- | --- |
| `<plugin>_<tool>` | Whatever the project's plugins offer through their [dev entries](#dev-entries), e.g. `kenney_search_packs` and `kenney_import` from `@mavonengine/kenney`, or `mail_inbox` and `mail_read` from `@mavonengine/mail`. Each says in its description what it does |

They appear when the dev server starts and go when plugins are removed: `mavonengine mcp` asks the dev server every few seconds and tells your assistant when the list changes. Unlike the tools above, a plugin's tool may change your project, e.g. copy files into it or edit `mavonengine.json`. Each says whether it does, and your MCP client asks you before running one that changes something. `--read-only` leaves those out.

The engine's own tools are read-only. It takes `--host`, `--port`, `--url` and `--token` like the dashboard, where `--url` is the server's base URL (`http://localhost:8050`). When Vite serves the client on its own port instead of through the game server, pass `--client-url`, e.g. `http://localhost:5173`.

The server scene and entity tools read `GET /api/game/dev/*` on the game server. Those routes are only registered when `NODE_ENV` is not `production`: a metrics token does not turn them on there. Otherwise they follow the [server access](#server-access) rules of the metrics endpoint.

The client tools go through the dev bridge of the Vite plugin in `@mavonengine/core/vite.config` (Vite 8). In dev it adds a small module to the page that answers over Vite's hot-reload WebSocket, and serves `GET /__mavonengine/clients` to localhost, or with `MAVONENGINE_METRICS_TOKEN` as bearer token when that is set for the dev server. Builds never include it. Turn it off with `mavonEnginePlugins({ devBridge: false })`.

`client_trace` patches the tab only while it records and puts everything back afterwards. It times every frame and composer pass, counts the WebGL calls on the context, keeps slow single calls (shader compiles, texture uploads, `readPixels` / `getError` stalls), long animation frames with the scripts that ran, and your own `performance.measure()` spans. GPU time per frame needs `EXT_disjoint_timer_query_webgl2` (Chrome and Edge on most GPUs; the three-perf panel pauses while tracing since it uses the same queries). JS call stacks come from the [JS Self-Profiling API](https://wicg.github.io/js-self-profiling/) in Chromium browsers: the Vite plugin serves dev pages with `Document-Policy: js-profiling` for it, so reload tabs opened before you updated. The trace file is [Chrome Trace Event](https://docs.google.com/document/d/1CvAClvFfyA5R-PhYUmn5OOQtYMH4h6I0nSsKchNAySU) JSON with tracks for frames, passes, GPU time, ticks, JS samples and slow WebGL calls: open it in [Perfetto](https://ui.perfetto.dev), `chrome://tracing` or [speedscope](https://www.speedscope.app). Keep the tab in the foreground while it records, browsers throttle hidden tabs.

The network tools read what both sides record while developing: every message through the game socket, the engine's and your own, with its size, and events such as `connect`, `disconnect`, `dropped` (the transport dropped a message), `sync_enter` / `sync_leave` (entities coming into or leaving a player's sync distance) and, on a client, `state_gap` (state updates that never arrived) and `state_out_of_order`. Each side keeps its last 2000 records, and 8 MB of their payloads. The server records when `NODE_ENV` is not `production` and serves them on `GET /api/game/dev/net/packets`, `/packets/:id` and `/sync`; a tab records while the dev bridge or the editor runs. Nothing is recorded, and the socket is left untouched, in a production build. `network_timeline` orders the two sides by their own clocks, which line up on one machine.

To let `compare_entity` match your own player with the server's, set `game.localPlayer` to the entity the tab controls, or give it `isLocalPlayer = true`: the server keys players by socket id, which the client often doesn't.

## Writing a plugin

[`mavonengine make:plugin`](#mavonengine-makeplugin) sets one up in your project. A plugin is an npm package with a `mavonengine` field in its `package.json`:

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
- `dev`: optional, for any target. An entry that runs in the client's Vite dev server, see [Dev entries](#dev-entries).
- `reloadOnOptions`: default `true`. Set it to `false` when the plugin changes its own `options` while the editor is open and its client picks up the change without a reload.

Each entry default-exports the plugin. Every hook gets the plugin's context last, which carries `package`, `options`, `game` and `logger`.

```ts
// client.ts
import { defineClientPlugin } from '@mavonengine/core/Plugins/types'

export default defineClientPlugin({
  assets: ctx => [
    {
      name: 'tree',
      type: 'gltfModel',
      path: ctx.assetUrl('models/tree.glb')
    }
  ],
  setup(ctx) {
    ctx.registerPrefab({
      name: 'Tree',
      spawn: position => ({
        object: new Tree(position)
      }),
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

### Dev entries

A plugin's `dev` entry runs in the client's Vite dev server, only in dev: tooling for the editor that has to work with the project's files, like downloading something and writing it into `client/public/`. It is never part of a build, and the game server never loads it.

```ts
// dev.ts
import { mkdirSync } from 'node:fs'
import { defineDevPlugin } from '@mavonengine/core/Plugins/types'

export default defineDevPlugin({
  setup(ctx) {
    mkdirSync(ctx.dataDir, { recursive: true })
  },
  // Answers under /__mavonengine/plugins/<package>/, with that prefix taken off req.url
  middleware: ctx => (req, res, next) => {
    if (req.url !== '/status')
      return next() // 404
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ options: ctx.options }))
  },
  destroy(ctx) {},
})
```

The client side calls it with `` fetch(`${devPluginBase(ctx.package)}status`) ``, using `devPluginBase` from `@mavonengine/core/Plugins/types`. Only requests from localhost reach the middleware, and requests that change something (anything but GET and HEAD) only when they come from the game's own page, so another site open in the browser can't make them. Paths in `req.url` come from the browser: resolve them with `resolveInside()` from `@mavonengine/core/Plugins/ProjectConfig` before reading or writing files.

The context has `package`, `options` (read from `mavonengine.json` on every access), `projectRoot`, `clientRoot`, `publicDir`, `logger`, and:

- `dataDir`: `.mavonengine/plugins/<package>/` in the project, for downloads and caches. The project's `.gitignore` leaves out `.mavonengine`, so nothing there is committed or shipped.
- `updateOptions(change)`: changes the plugin's `options` in `mavonengine.json`. Use it to record what should be committed with the project.

A dev entry can also give AI assistants tools, which [`mavonengine mcp`](#mavonengine-mcp) offers as `<plugin>_<tool>`: the package name without its scope, then the tool's name.

```ts
export default defineDevPlugin({
  mcpTools: ctx => [
    {
      name: 'add_tree', // my-plugin_add_tree
      title: 'Add a tree',
      description: 'Adds a tree to the list in the plugin\'s options. Use it when the user asks for more trees',
      input: {
        type: 'object',
        properties: {
          kind: {
            type: 'string',
            enum: ['pine', 'oak']
          }
        },
        required: ['kind']
      },
      run: ({ kind }) => {
        ctx.updateOptions((options) => {
          options.trees = [
            ...(options.trees as string[] ?? []),
            kind
          ]
        })
        return { trees: ctx.options.trees }
      },
    },
  ],
})
```

- `input` is the JSON Schema of the arguments, an object; `mavonengine mcp` turns away calls that don't match it. The arguments still come from a model, so check them in `run()` as you would any input, e.g. paths with `resolveInside()`.
- What `run()` returns goes to the assistant as JSON. What it throws is reported as the tool's error.
- Set `readOnly: true` on tools that change nothing; the rest are taken to change something, so assistants ask first and `mavonengine mcp --read-only` leaves them out. `destructive: true` marks one that deletes or overwrites what can't be had back, `openWorld: true` one that reaches outside the project, e.g. a website.
- The dev server lists them on `GET /__mavonengine/mcp/tools` and runs them on `POST /__mavonengine/mcp/tools/<name>` with `{ "arguments": … }`, only for requests from this machine and never for another site open in the browser.

Dev entries start with the dev server and restart when plugins are added, removed, turned on or off in `mavonengine.json`. Changing options doesn't restart them. One that fails to start is logged, and its URLs answer 404 with the reason.

Guard a plugin's admin routes with `ctx.requireAdmin`, which asks for the server's [admin token](#admin-token), instead of giving the plugin a token of its own:

```ts
export default defineServerPlugin({
  http(app, ctx) {
    app.post('/api/my-plugin/reset', ctx.requireAdmin, (_req, res) => res.json({ reset: true }))
  },
})
```

A plugin that takes the token some other way, such as the password of a login, checks it with `ctx.adminToken.matches(candidate)`, without ever seeing the token.

### Admin panel pages

The game server serves an admin panel at `/admin/`: one layout with a sidebar, behind a login that takes the [admin token](#admin-token) as the password (any user name). The engine adds Overview, Routes and Plugins pages. A plugin adds its own with `ctx.admin.page()`, and it shows up in the sidebar under **Plugins**, with the links it gives listed below it:

```ts
export default defineServerPlugin({
  http(app, ctx) {
    ctx.admin.page({
      path: 'chat', // /admin/chat/
      label: 'Chat',
      icon: 'chat', // dashboard, activity, routes, plugin, database, users, logs, settings, chart, mail, chat, bell or lock
      children: [
        { label: 'Live', href: '#live' }, // an anchor on the page
        {
          label: 'Mutes',
          href: 'mutes',
          render: () => '<p>…</p>'
        }, // a sub page, /admin/chat/mutes/
      ],
      render: req => ({
        html: '<div class="adm-page">…</div>',
        styles: [
          ctx.admin.url('chat/style.css')
        ],
        scripts: [
          ctx.admin.url('chat/app.js')
        ],
      }),
    })

    // Every route under the panel's path is behind its login already
    app.get(ctx.admin.url('chat/api/messages'), (_req, res) => res.json({ messages: [] }))
  },
})
```

The page's HTML goes into the layout as is: escape whatever came from players with `escapeHtml()` from `@mavonengine/core/Networking/Server/Admin/AdminPanel`. Inline scripts are blocked by the page's Content-Security-Policy, so ship script files. The layout's colors are CSS custom properties (`--surface`, `--border`, `--primary`, …), and it has helpers for pages: `adm-page`, `adm-cards`, `adm-card`, `adm-table`, `adm-badge`. `ctx.admin.addLogin((user, password) => …)` lets more people log in than whoever has the token, such as the users of an htpasswd file.

Without an admin token the panel only answers localhost, and in production it stays off until the server has a token or a plugin added a login. Move it with `admin: { path: '/ops' }` in the server's options, or turn it off with `admin: { enabled: false }`.

### Authenticating players

An auth plugin decides who may connect, before a client gets a player. [`@mavonengine/auth`](https://github.com/MavonEngine/Core/tree/main/packages/plugins/auth) is one, with accounts, passwords and sessions; write your own for anything else. Its client entry gives the token the game connects with, and its server entry's `authorize()` checks it:

```ts
// client.ts: sent as the Authorization header of the connection request
export default defineClientPlugin({
  authorization: () => {
    const token = localStorage.getItem('session')
    return token
      ? `Bearer ${token}`
      : undefined
  },
})
```

```ts
// server.ts
export default defineServerPlugin({
  async authorize(authorization, request, ctx) {
    const account = await findSession(ctx.db, authorization)
    if (!account)
      return false // 401
    if (account.banned)
      return 403
    return { id: account.id, name: account.username }
  },
})
```

`authorize()` returns an identity (`{ id, name?, … }`) to let the client in as that account, `true` to let it in without one (a guest), or `false` or an HTTP status from 400 to 599 to turn it away. The identity is also sent to the client, so keep it to what the player may see. A throw or any other result turns that one client away with 500, and the next client is still asked.

Other plugins read the identity with `ctx.identity(channel)`, and the game with `player.identity` on the server or `network.identity` on the client. Key anything that should outlast a connection, such as a mute or a score, on `identity.id`: `channel.id` changes every time the player reconnects.

On the client, a refusal arrives as the `connectError` event of the `NetworkManager` (and its `onConnectError()`), with the `status` the server answered. The token is read when a `NetworkManager` is made, so to connect again after logging in, make a new one. A game that handles the token itself passes `authorization` to the `NetworkManager` instead.

Only one auth plugin is asked: with more than one enabled, set `"auth": "<package>"` in mavonengine.json. When the project has an auth plugin that doesn't run, for example because one of its migrations failed or the package named in `auth` isn't enabled, the server turns every client away with 503 instead of letting them in unchecked. The editor connects like a client too, so with an auth plugin it needs a token as well: when the server turns it away, the editor's status bar and Network panel say why. A server in production (`NODE_ENV=production`) ignores clients that ask to attach the editor, since the editor is sent every entity in the world.

Projects made with `mavonengine create` are already set up for plugins. To set up an existing project:

```ts
// client: Game.usePlugins() before new Game()
import Game from '@mavonengine/core/Game'
import plugins from 'virtual:mavonengine/plugins'

Game.usePlugins(plugins)
```

```ts
// server: the directory with mavonengine.json
const server = new MyServer(logger, physicsWorld, {
  plugins: { root: projectRoot }
})
await server.start()
```

The client's Vite config needs to extend `@mavonengine/core/vite.config`, which provides `virtual:mavonengine/plugins`, serves plugin assets in dev and copies them into the release.
