# Multiplayer Template

Bootstrap this template instantly with:

```bash
npx @mavonengine/cli create my-game
```

A ready-to-use multiplayer 3D game template built on the [MavonEngine](https://mavonengine.com/) framework. It demonstrates a client-server architecture with authoritative physics, real-time state synchronisation, player animations, chat, and a 3D world with environmental objects.

**Stack:** Vue 3 + Three.js (client) · Node.js + Three.js (server) · RAPIER physics · geckos.io networking all tied together with MavonEngine

> **Note:** This template has only been tested with Node.js 24.

**Links:**
- [Website](https://mavonengine.com/)
- [Getting Started](https://mavonengine.com/getting-started)
- [Community](https://mavonengine.com/community)

---

## Architecture Overview

The template is split into two workspaces:

```
packages/multiplayer-template/
├── client/   – Vue 3 frontend: rendering, input, UI, animation
└── server/   – Node.js backend: authoritative physics, state sync, commands
```

Both workspaces share base classes that live in `server/src/Base/`. The server uses them directly; the client extends them to add graphics and animations.

---

## Base Classes

These are the foundation of the template. Understanding them is the key to extending the project.

### `Base/Player` (`server/src/Base/Player.ts`)

Extends `BasePlayer` from `@mavonengine/core`. This is the single source of truth for everything that must be consistent between server and client.

Responsibilities:
- **Health system** – `health`, `maxHealth`, `isDead`, `takeDamage()`, `heal()`
- **Physics** – RAPIER kinematic capsule collider and character controller
- **Movement state machine** – manages `IdleState` / `WalkingState` via a state stack
- **Network serialisation** – `updateFromNetwork()` applies incoming server snapshots

The server's `Server/Entities/Player` extends this with server-only concerns (e.g. authoritative state initialisation). The client's `Entities/Player` (called `Character`) extends it again with a `PlayerGraphicsComponent` for Three.js mesh rendering and a `PlayerLabel` for name/chat bubbles.

### `Base/Vegetation/Tree` (`server/src/Base/Vegetation/Tree.ts`)

Extends `GameObject` from `@mavonengine/core`. Creates a RAPIER static cylinder collider for tree physics. The client extends this (without additions) and separately manages all tree rendering via an instanced mesh in `World/Trees.ts`.

---

## Player States

States are layered: the server defines the logic, the client extends each state to add animation.

| State | Server responsibility | Client addition |
|---|---|---|
| `IdleState` | Watches `keysPressed`, transitions to Walking when movement keys are held | Triggers idle animation on `enter()` |
| `WalkingState` | Reads `keysPressed`, computes `horizontalIntent`, applies physics velocity | Triggers walk animation on `enter()` |

---

## Server

**Entry point:** `server/src/index.ts` → initialises RAPIER physics world, then starts `Server`.

## Scenes

The map lives in `scenes/main.json`. Both sides load it; each builds only the scene objects it registered a factory for:

| Object | Client | Server |
|---|---|---|
| `Light:*`, `Primitive:Plane` (sky, sun, ground) | rendered | kept as data |
| `TreeField` | kept as data, renders the trees the server sends | colliders + `SV_TREES` |

Press `.` in the game to open the editor on the running game: the connection to the server stays, so you see the trees and other players live, but the server stops treating you as a player. Edit the scene (the **Scene** tab lists what is saved, server-only objects get their props edited there) and save with Ctrl+S. The file is written, the server reloads it and every client gets the result.

**`Server.ts`** extends `BaseServer<Player>` and is responsible for:

- Loading the map from `scenes/main.json` (shared with the client) and building the parts it needs: the `TreeField` scene object (`Base/Vegetation/TreeField.ts`) places its trees from a seed, creates their colliders and the server sends them to each connecting client (`SV_TREES`) — this demonstrates that the environment is server-controlled; the server decides what exists in the world and where, so the same pattern can be applied to any world object (destructible props, spawnable items, dynamic obstacles, etc.). The lights and ground in the same file are built by the client only. In dev the server reloads the scene whenever the editor saves it
- Creating a player at a random spawn point on connection
- Processing `CL_MOVE` commands (updates `keysPressed` and yaw rotation)
- Relaying `CL_CHAT` messages to all clients as `SV_CHAT`
- Broadcasting `SV_STATE` snapshots to each client for entities within 200 units

---

## Client

**Entry point:** `client/src/main.ts` → sets up Vue, loads resources, creates the game loop, then hands off to `GameWorld`.

### Key classes

| Class | File | Responsibility |
|---|---|---|
| `GameWorld` | `Scenes/GameWorld.ts` | Scene setup: ground, lighting, shadows, fog |
| `Character` | `Entities/Player.ts` | Local and remote players with graphics and labels |
| `PlayerGraphicsComponent` | `Entities/Player/PlayerGraphicsComponent.ts` | Loads GLTF model, maps and plays animations |
| `PlayerController` | `PlayerController.ts` | Keyboard input, third-person camera (OrbitControls), sends `CL_MOVE` |
| `GameSyncManager` | `GameSyncManager.ts` | Processes `SV_STATE`: spawns/despawns entities within 150 units |
| `NetworkManager` | `NetworkManager.ts` | geckos.io socket wrapper; maps incoming/outgoing commands |
| `Trees` | `World/Trees.ts` | Instanced mesh renderer for all trees received from server |
| `PlayerLabel` | `ui/PlayerLabel.ts` | 3D text labels for player names and chat bubbles |

### Network commands

**Client → Server**

| Command | Payload |
|---|---|
| `CL_INIT` | `{ name: string }` |
| `CL_MOVE` | `{ keys: string[], yaw: number }` |
| `CL_CHAT` | `{ message: string }` |

**Server → Client**

| Command | Payload |
|---|---|
| `SV_STATE` | `{ tick, serverTime, ack, entities: [{ id, position, rotation, state, health, name }] }`: `tick` counts server ticks, `ack` is the sequence id of the receiver's last processed input |
| `SV_REMOVE_ENTITY` | `{ id: string }` |
| `SV_CHAT` | `{ playerId, playerName, message }` |
| `SV_TREES` | `{ positions, rotations, scales }` (flat typed arrays) |

---

## Debug Mode

To view the scene from the server's perspective (what the authoritative physics world sees), navigate to:

```
http://localhost:8050/#debug
```

This enables the debug overlay and renders the server-side physics colliders and entity positions directly in the browser.

---

## Getting Started

From the workspace root:

```bash
npm install
npm run dev          # mavonengine dev: the game server with the dashboard, and the game opens in the browser
npm run dev:server   # only the game server in watch mode, with its output in the terminal
```

`npm run dev` runs `mavonengine dev`, which starts the `dev:server` script and shows the server's dashboard in the terminal (CPU, tick time, players, logs, HTTP requests). Quitting it (`q` or Ctrl-C) stops the server. Without an interactive terminal, e.g. in CI, it just runs `dev:server`. Pass options through npm, e.g. `npm run dev -- --no-open`.

Open `http://localhost:8050`. The game server serves the client on its HTTP port, with hot reload for client changes. Server changes rebuild and restart the server, which reloads the page. The client connects to the game socket through `/socket` on the same port, so everything runs on `8050`.

The game server exposes a JSON API with a health endpoint:

```
GET http://localhost:8050/api/game/health
```

### Production

```bash
npm run build
npm start --prefix server
```

The server serves the built client from `client/dist` on port `8050`, and the game socket is reachable on the same port, so a single process is enough. Vite is never loaded outside `npm run dev`. Behind a reverse proxy or CDN you can still serve `client/dist` yourself and forward `/socket` to the game server's port `8050`.

---

## Credits

### 3D Models & Assets

Character models and animations provided by:

- **Kenney** – [kenney.nl](https://kenney.nl) — game assets released into the public domain (CC0)
- **Mixamo** – [mixamo.com](https://www.mixamo.com) — character animations by Adobe
