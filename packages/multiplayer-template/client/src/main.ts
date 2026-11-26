import type { App } from 'vue'
import RAPIER from '@dimforge/rapier3d-compat'
import Game from '@mavonengine/core/Game'
import XR from '@mavonengine/core/XR'
import plugins from 'virtual:mavonengine/plugins'
import { createApp } from 'vue'
import GameWorld from './Scenes/GameWorld'
import Frame from './UI/Frame.vue'
import './game.css'

/** Browsers that run on the headset itself: Quest, Pico, Wolvic */
const STANDALONE_HEADSET = /OculusBrowser|Quest|Pico|Wolvic/i

// Engine plugins from mavonengine.json, see `mavonengine install`
Game.usePlugins(plugins)

if (import.meta.env.DEV) {
  Game.devModeHook = () => {
    import('@mavonengine/editor').then(({ default: Editor }) => Editor.registerListener())
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

  // Cap the rendering, the game tick and physics keep their own rate
  game.renderer.maxFps = 60

  // Play in a VR headset: an "Enter VR" button shows on devices that can (e.g. a Quest's browser), the left
  // stick walks and the right stick turns the view. The headset sets the frame rate there, not maxFps
  XR.isSupported().then((supported) => {
    if (supported) {
      // On a PC headset (SteamVR, Quest Link) the browser window keeps showing the game. Not on a standalone headset,
      // whose browser hides the page while in VR: drawing it there would only cost frame rate
      game.enableXR({ mirror: !STANDALONE_HEADSET.test(navigator.userAgent) })
    }
  })

  // The map: sky, lights and ground, shared with the server which builds the trees from it. Edit it in the editor (press .)
  game.openScene('main').catch(err => game.logger?.error(`Could not load the scene: ${(err as Error).message}`))

  let serverWorld: GameWorld | null = null

  function joinServer() {
    serverWorld?.destroy()
    serverWorld = new GameWorld()
  }

  window.addEventListener('gameUIReady', joinServer)

  // Opened the editor before joining: connect anyway, without a player, to show what the server sends (trees, players)
  game.on('editorBoot', () => {
    serverWorld ??= new GameWorld(true)
  })

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
