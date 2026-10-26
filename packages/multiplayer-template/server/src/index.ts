import process from 'node:process'
import { fileURLToPath } from 'node:url'
import RAPIER from '@dimforge/rapier3d-compat'
import logger from './Logger'
import Server from './Server'

RAPIER.init().then(() => {
  const physicsWorld = new RAPIER.World({ x: 0, y: -9.83, z: 0 })

  const groundBody = physicsWorld.createRigidBody(RAPIER.RigidBodyDesc.fixed())
  physicsWorld.createCollider(
    RAPIER.ColliderDesc.cuboid(100, 0.5, 100).setTranslation(0, -0.5, 0),
    groundBody,
  )

  const server = new Server(logger, physicsWorld, {
    client: {
      root: fileURLToPath(new URL('../../client', import.meta.url)),
      // Set by `npm run dev`: serve the client source through Vite. Otherwise the built client/dist is served
      dev: process.env.MAVONENGINE_DEV_CLIENT === '1',
    },
  })
  server.start()
})
