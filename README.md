# MavonEngine — Three.js Game Engine for Browser Games

MavonEngine is an open-source Three.js game engine built for single player or real-time multiplayer. It combines
rendering, physics, networking, animation, and debugging into a single cohesive TypeScript package
— so you're not assembling a stack, you're building a game.

> **Early WIP** — things will change. For documentation visit [mavonengine.com](https://mavonengine.com).

## Get Started
```bash
npx @mavonengine/create-bootstrap
```

| URL | Description |
| --- | --- |
| http://localhost:5173/ | Client Game |
| http://localhost:8050/api/game/health | Server health endpoint |

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
- **Level editor** — Early WIP, loads directly from the running game instance
- **Prefab registry** — Community-built assets (grass, water, and more) ready to drop into your scene
- **Full TypeScript** — Comprehensive types throughout

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
