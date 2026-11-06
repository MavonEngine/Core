export default {
  name: 'Hello',
  assets: ctx => [
    { name: 'helloTree', type: 'gltfModel', path: ctx.assetUrl('models/tree.gltf') },
    { name: 'helloRock', type: 'gltfModel', path: ctx.assetUrl('models/rock.gltf') },
  ],
  setup(ctx) {
    ctx.registerPrefab({ name: 'Tree', spawn: () => ctx.logger?.info('hello-plugin: Tree placed') })
    ctx.registerPrefab({ name: 'Rock', spawn: () => ctx.logger?.info('hello-plugin: Rock placed') })
  },
}
