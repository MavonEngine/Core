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

  const server = new Server(logger, physicsWorld)
  server.start()
})
