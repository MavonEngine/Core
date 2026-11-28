# @mavonengine/polyhaven

Browse [Poly Haven](https://polyhaven.com)'s CC0 textures and models in the editor, and pull them into your project with one click. Textures arrive as a ready material graph you can edit in the Graphs view.

```bash
npx @mavonengine/cli install @mavonengine/polyhaven
```

Or install it from the editor's Plugins view.

## Using it

The editor gets a **Poly Haven** tab in the bottom dock. Pick Textures or Models, search by name, tag or category, choose a resolution (1k to 8k), and press **Import**.

- **Imported** shows only what the project has imported.
- **Drag a card into the viewport** to use it there. A model is placed on the ground where you drop it. A texture's material graph goes on the primitive you drop it on (a plane, box, sphere…). Both are added to the open scene, so saving the scene keeps them. An asset that isn't imported yet is imported first, at the selected resolution.
- **Double-click a card** to open a preview window. A model is shown as it is. A texture's material is shown on a sphere, cube or plane. Drag to orbit, scroll to zoom, right-drag to pan. Previewing an asset that isn't imported yet imports it first.

- **A texture** downloads its base color, OpenGL normal map and ARM map (AO, roughness, metalness) into `client/public/polyhaven/<id>/`. Each map becomes a texture resource named `polyhaven_<id>_diff`, `polyhaven_<id>_nor` and `polyhaven_<id>_arm`, so any **Texture** node can pick it. The plugin also writes the material graph `graphs/polyhaven_<id>.graph.json`:

  ```
  UV × tiling ─┬─ Texture (diff) ── rgb ──────────────────────── Base Color
               ├─ Texture (arm)  ── Split ── y ───────────────── Roughness
               │                          └─ z ───────────────── Metalness
               └─ Texture (nor)  ── rgb ── Normal Map ── normal ─ Normal
  ```

  To use it, pick `polyhaven_<id>` as a primitive's material graph. Change the `tiling` parameter to repeat the texture. Importing a texture again replaces its files but keeps the graph if you already edited it.
- **A model** downloads its glTF, `.bin` and textures into `client/public/polyhaven/<id>/`. It loads as the resource `polyhaven_<id>`.

Imports load into the open editor right away, without a reload. They are recorded under `imported` in the plugin's options in `mavonengine.json`, so the game loads them on every start, in dev and in a release. Commit `client/public/polyhaven/`, `graphs/` and `mavonengine.json` together.

The base color is set to sRGB and every map is set to repeat. Three's texture loader leaves both off.

### The Normal Map node

The plugin adds a **Normal Map** node (category Texture, `@mavonengine/polyhaven:normalMap` in graph files). It turns a tangent-space normal map into the surface normal that the Material Output's **Normal** input expects, with a **Strength** input. You can use it with any normal map, not just Poly Haven's.

## Caching

The browser never talks to Poly Haven. The plugin's dev entry fetches everything and keeps it in `.mavonengine/plugins/@mavonengine/polyhaven/`, which is not committed:

| What | Where | Kept |
| --- | --- | --- |
| Asset lists, file lists | `api/` | A day, then refreshed. Used however old when Poly Haven can't be reached |
| Thumbnails | `thumbs/<id>.png` | Until you delete them |
| Downloads | `downloads/<id>/<resolution>/` | Until you delete them: importing again or at another resolution reuses them |

Delete the directory to start over.

## Poly Haven's terms

The assets are [CC0](https://polyhaven.com/license): you can use them for anything, commercial work included, without credit. The [API terms](https://github.com/Poly-Haven/Public-API/blob/master/ToS.md) ask a tool built on the live API to say where the assets come from, and to send a User-Agent naming the software. The panel shows "Assets from Poly Haven, CC0. Powered by Poly Haven", and every request sends `MavonEngine-PolyHaven/<version>`. Files only download from `dl.polyhaven.org`.

HDRIs are not offered yet: the engine has no loader for `.hdr` environment maps.
