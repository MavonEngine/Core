import type { App } from 'vue'
import RAPIER from '@dimforge/rapier3d-compat'
import Game from '@mavonengine/core/Game'
import { createApp } from 'vue'
import GameWorld from './Scenes/GameWorld'
import Frame from './UI/Frame.vue'
import './game.css'

if (import.meta.env.DEV) {
  Game.devModeHook = () => {
    import('@mavonengine/editor').then(({ default: Editor }) => {
      Editor.registerListener()
      Game.instance().trigger('editorRegistered')
    })
  }
}

RAPIER.init().then(() => {
  const physicsWorld = new RAPIER.World({ x: 0, y: -9.83, z: 0 })

  const groundBody = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  physicsWorld.createCollider(
    RAPIER.ColliderDesc.cuboid(100, 0.5, 100).setTranslation(0, -0.5, 0),
    groundBody,
  )

  const game = new Game([
    { name: 'pine', type: 'gltfModel', path: '/pine.glb' },
    { name: 'character', type: 'gltfModel', path: '/character.glb' },
  ], physicsWorld)

  let serverWorld: GameWorld | null = null

  function joinServer() {
    serverWorld?.destroy()
    serverWorld = new GameWorld()
  }

  window.addEventListener('gameUIReady', joinServer)

  let app: App<Element> | null = null

  game.on('documentReady', () => {
    app = createApp(Frame)
    app.mount('#ui')
    game.trigger('uiMounted')
  })

  game.on('uiDestroy', () => {
    app?.unmount()
  })
})
