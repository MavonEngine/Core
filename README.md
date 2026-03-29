# MavonEngine

A TypeScript game engine with support for single and multiplayer games with an authoritative server.

> **Early WIP** — things will change. For documentation visit [mavonengine.com](https://mavonengine.com).

## Getting started

```bash
npx @mavonengine/create-bootstrap
```
| URL | Description |
|-----|-------------|
| http://localhost:5173/ | Client Game |
| http://localhost:8050/api/game/health | Server health endpoint |

The multiplayer template includes the authoritative server setup, networking boilerplate, and a working client/server split out of the box.

## What is this?

MavonEngine is a TypeScript game engine built on top of [Three.js](https://threejs.org/) for rendering, [Rapier3D](https://rapier.rs/) for physics, and [geckos.io](https://github.com/geckosio/geckos.io) for WebRTC-based UDP networking. It provides a set of abstractions for the things that come up repeatedly when building 3D games — entity management, state machines, world/chunk streaming, input handling, resource loading, and multiplayer networking.

## Core idea

The central design is a headless `BaseGame` class that both the client and server extend from. The server runs the headless version (physics + game loop, no rendering), while the client extends it with Three.js rendering, camera, audio, and input. Because both sides share the same underlying loop and entity classes, game logic can be written once and shared, with the authoritative server syncing state down to clients each tick.

## Multiplayer

The networking model is inspired by Source engine networking — a tick-based command buffer queue with server-authoritative state, distance-based entity visibility, and bandwidth tracking. The client manages a WebRTC connection via geckos.io with ping monitoring and state reconciliation.

## Contributing

This is early-stage software built out of real project needs. APIs will break and some parts are still tightly coupled to specific project setups. Contributions and PRs are welcome — see the [contributing guide](https://mavonengine.com/getting-started/contributing) to get started.

Join the [community](https://mavonengine.com/community) for development discussions.
