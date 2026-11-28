import type Game from '@mavonengine/core/Game'
import type { Object3D } from 'three'
import type { ImportedAsset } from './shared'
import { materialGraphs } from '@mavonengine/core/Graph/Material/MaterialGraphs'
import { defineClientPlugin, devPluginBase } from '@mavonengine/core/Plugins/types'
import { RepeatWrapping, SRGBColorSpace, Texture } from 'three'
import { dropHandler } from './drop'
import { normalMapNode, normalMapTsl } from './nodes'
import { mountPanel } from './panel'
import { openPreview } from './preview'
import { waitUntilServed } from './served'
import { importedAssets, importedResources, modelResource, PACKAGE, TEXTURE_MAPS, textureResource } from './shared'

/** Textures already set up for tiling and color, so it happens once each */
const prepared = new WeakSet<Texture>()

/**
 * Poly Haven's textures tile, and their base color is sRGB: the TextureLoader leaves both off. Set them on the
 * imports' textures that are loaded, which every Texture node sampling them picks up.
 */
export function prepareTextures(game: Pick<Game, 'resources'>, imported: ImportedAsset[]) {
  for (const entry of imported) {
    if (entry.kind !== 'textures')
      continue
    for (const map of Object.keys(TEXTURE_MAPS) as (keyof typeof TEXTURE_MAPS)[]) {
      const item = game.resources.items[textureResource(entry.id, map)] as unknown
      if (!(item instanceof Texture) || prepared.has(item))
        continue
      item.wrapS = RepeatWrapping
      item.wrapT = RepeatWrapping
      if (map === 'diff')
        item.colorSpace = SRGBColorSpace
      item.needsUpdate = true
      prepared.add(item)
    }
  }
}

export default defineClientPlugin({
  name: 'Poly Haven',

  // What earlier imports put in the public directory, loaded with the game, in dev and in a release
  assets: ctx => importedResources(importedAssets(ctx.options)),

  setup(ctx) {
    ctx.registerNode(normalMapNode, normalMapTsl)

    const imported = importedAssets(ctx.options)
    const prepare = () => prepareTextures(ctx.game, imported)
    prepare()
    ctx.game.resources.on('loaded', prepare)
  },

  editor(ctx) {
    // Imported while the editor is open: the options the page started with don't have them yet
    const imported = importedAssets(ctx.options)

    ctx.editor.addPanel({
      id: PACKAGE,
      title: 'Poly Haven',
      location: 'bottom',
      order: 20,
      padded: false,
      mount: container => mountPanel(container, {
        base: devPluginBase(PACKAGE),
        imported: () => imported,
        preview: entry => openPreview(entry, {
          webgpu: ctx.game.renderer.isWebGPU,
          model: e => (ctx.game.resources.items[modelResource(e.id)] as { scene?: Object3D } | undefined)?.scene,
          material: async e => (await materialGraphs.load(e.graph!)).material,
        }),
        // The scene explorer and properties refresh on this, like for the editor's own drops
        drop: dropHandler(ctx.game, () => ctx.editor.trigger('assetDropped')),
        async onImported(entry) {
          const index = imported.findIndex(existing => existing.id === entry.id)
          if (index >= 0)
            imported.splice(index, 1)
          imported.push(entry)
          await waitUntilServed(Object.values(entry.files))
          await ctx.game.resources.add(importedResources([entry]))
          prepareTextures(ctx.game, [entry])
          // The new graph, for the material graph pickers and the Graphs view
          await materialGraphs.refreshList()
        },
      }),
    })
  },
})
