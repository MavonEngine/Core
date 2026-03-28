# Multiplayer Template

Bootstrap this template instantly with:

```bash
npx @mavonengine/create-bootstrap
```

A ready-to-use multiplayer 3D game template built on the [MavonEngine](https://mavonengine.com/) framework. It demonstrates a client-server architecture with authoritative physics, real-time state synchronisation, player animations, chat, and a 3D world with environmental objects.

**Stack:** Vue 3 + Three.js (client) · Node.js + Three.js (server) · RAPIER physics · geckos.io networking all tied together with MavonEngine

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

**`Server.ts`** extends `BaseServer<Player>` and is responsible for:

- Spawning 15 trees at random positions within an 80-unit radius on startup and sending their data to each connecting client (`SV_TREES`) — this demonstrates that the environment is fully server-controlled; the server decides what exists in the world and where, so the same pattern can be applied to any world object (destructible props, spawnable items, dynamic obstacles, etc.)
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
| `SV_STATE` | `{ entities: [{ id, position, rotation, state, health, name }] }` |
| `SV_REMOVE_ENTITY` | `{ id: string }` |
| `SV_CHAT` | `{ playerId, playerName, message }` |
| `SV_TREES` | `{ positions, rotations, scales }` (flat typed arrays) |

---

## Debug Mode

To view the scene from the server's perspective (what the authoritative physics world sees), navigate to:

```
http://localhost:5173/#debug
```

This enables the debug overlay and renders the server-side physics colliders and entity positions directly in the browser.

---

## Getting Started

From the workspace root:

```bash
npm install
npm run dev        # starts both client and server in watch mode
```

The client runs at `http://localhost:5173` and the server listens on port `8081`.

The game server exposes a JSON API with a health endpoint:

```
GET http://localhost:8050/api/game/health
```

---

## Credits

### 3D Models & Assets

Character models and animations provided by:

- **Kenney** – [kenney.nl](https://kenney.nl) — game assets released into the public domain (CC0)
- **Mixamo** – [mixamo.com](https://www.mixamo.com) — character animations by Adobe
