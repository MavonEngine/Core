# MavonEngine — Three.js Game Engine for Browser Games

MavonEngine is an open-source Three.js game engine built for single player or real-time multiplayer. It combines
rendering, physics, networking, animation, and debugging into a single cohesive TypeScript package
— so you're not assembling a stack, you're building a game.

> **Early WIP** — things will change. For documentation visit [mavonengine.com](https://mavonengine.com).

## Get Started
```bash
npx @mavonengine/cli create my-game
```

This downloads the multiplayer template, installs it, starts the game server and opens the game in
your browser, with a live dashboard of the server in the terminal.

Everything runs on one port: the game server serves the client (with hot reload in dev) and the
game socket next to its own API.

| URL | Description |
| --- | --- |
| http://localhost:8050/ | Client game |
| http://localhost:8050/#debug | Debug mode: debug UI and the server's physics colliders |
| http://localhost:8050/api/game/health | Server health endpoint |

Press `.` in the game to open the level editor.

The multiplayer template includes the authoritative server setup, networking boilerplate, and a
working client/server split out of the box.

## What is MavonEngine?

MavonEngine is a full-stack Three.js game engine built on top of [Three.js](https://threejs.org/)
for rendering, [Rapier3D](https://rapier.rs/) for physics, and
[geckos.io](https://github.com/geckosio/geckos.io) for WebRTC-based UDP networking.

Most Three.js game engines focus on single-player or leave multiplayer as an exercise for the
developer. MavonEngine is designed from the ground up for multiplayer — with a unified server-client
architecture, authoritative physics, and real-time networking built in, not bolted on.

## How It Works

The core is a headless `BaseGame` class that both client and server extend from. The server runs
physics and the game loop without rendering. The client extends it with Three.js rendering, camera,
audio, and input. Because both sides share the same entity classes and loop, game logic is written
once and shared — the authoritative server syncs state down to clients each tick.

The server runs a simplified hitbox scene alongside the client's full 3D world, enabling
server-side hit detection, raycasting, and spatial queries without trusting the client. This makes
it viable for competitive PvP games, open-world multiplayer, and physics-based action games.

## Networking

The networking model is inspired by Source engine architecture — a tick-based command buffer with
server-authoritative state, distance-based entity culling, hash-based change detection, and
bandwidth tracking. The client maintains a WebRTC connection via geckos.io with ping monitoring
and state reconciliation.

## Features

- **Three.js rendering** — Custom GLSL shader support, wireframe/armature/physics debug overlays
- **Rapier3D physics** — Kinematic character controller, collider management, real-time debug visualization
- **WebRTC networking** — Real-time data channels, bandwidth monitoring, command buffering
- **Shared entity system** — Write once, run on server and client
- **Skeletal animation** — GLTF + Draco support, smooth fade transitions, efficient skeleton cloning
- **Particle system** — Built-in rain and smoke effects, custom shader support
- **Level editor** — Early WIP, loads directly from the running game instance and stays connected to the server
- **Scenes** — JSON scene files shared by client and server; each side builds only what it needs, and the server
  reloads a scene when the editor saves it
- **Prefab registry** — Community-built assets (grass, water, and more) ready to drop into your scene
- **Engine plugins** — `mavonengine install` adds plugins with their client, server and asset parts;
  `mavonengine build` ships only the assets your game uses
- **Gamepad support** — Xbox, PlayStation and generic controllers with deadzones, button labels and rumble
- **Monitoring** — `mavonengine dashboard` in the terminal, or the `@mavonengine/http-monitoring` plugin in the
  browser: tick time, CPU, bandwidth, players, logs and HTTP requests
- **Latency simulation** — Test your netcode against artificial latency, jitter and packet loss
- **AI assistant support (MCP)** — `mavonengine mcp` lets any MCP client and model inspect the running game:
  server metrics, scenes and entities, the browser tabs' renderer stats, console and screenshots, and one entity
  compared on server and client
- **Full TypeScript** — Comprehensive types throughout

## AI Assistants

Projects created with `mavonengine create` include a `.mcp.json`, so MCP clients that read it (such as Claude Code)
pick up the MavonEngine MCP server automatically. For other clients (Cursor, VS Code, Codex, Gemini CLI, Zed, …),
register it as a stdio server:

```json
{
  "mcpServers": {
    "mavonengine": { "command": "npx", "args": ["-y", "@mavonengine/cli", "mcp"] }
  }
}
```

Every tool is read-only. Scene, entity and client tools only work in development; see the
[CLI README](packages/cli/README.md#mavonengine-mcp) for the full list.

## Why a Three.js Game Engine with Multiplayer?

Three.js is the most widely used 3D library for the web, but it's a rendering library — not a game
engine. MavonEngine fills that gap specifically for single or multiplayer: entity management, state machines,
world/chunk streaming, input handling, resource loading, and authoritative networking are all
handled for you.

## Contributing

This is early-stage software built out of real project needs. APIs will change and some parts are
still tightly coupled to specific setups. Contributions and PRs are welcome — see the
[contributing guide](https://mavonengine.com/getting-started/contributing) to get started.

Join the [community](https://mavonengine.com/community) for development discussions.
