# @mavonengine/editor

**Early WIP** — map saving and loading are not yet implemented. Currently useful mainly for browsing and viewing assets in a 3D scene.

An in-engine editor for [MavonEngine](https://mavonengine.com) — a [threejs game engine](https://mavonengine.com) — that provides a 3D scene editing interface. It can be activated at runtime by pressing `Insert` or `.` (Period), which boots the editor, destroys the current world, and mounts a React-based UI overlay.

Current features include:
- Fly camera controls for scene navigation
- Object selection and transform controls (translate, rotate, scale)
- Shade modes: solid, flat, and wireframe
- Light and object helpers
- Asset browser with category filtering
- Primitives and lights available for placement in the scene

## Testing

### E2E Tests

E2E tests **must** be run via the official Playwright Docker image. Running them directly on your local system will cause snapshot diffs to fail due to rendering differences between environments (fonts, etc.).

```bash
docker run --rm \
    -v $(pwd):/app \
    -w /app/packages/editor \
    mcr.microsoft.com/playwright:v1.52.0-noble \
    npm run test:e2e
```

### Updating Snapshots

To update snapshots, pass the `--update-snapshots` flag via the same Docker container:

```bash
docker run --rm \
    -v $(pwd):/app \
    -w /app/packages/editor \
    mcr.microsoft.com/playwright:v1.52.0-noble \
    npm run test:e2e -- --update-snapshots
```
