import type RAPIER from '@dimforge/rapier3d-compat'
import type { Scene } from 'three'
import { BufferAttribute, BufferGeometry, LineBasicMaterial, LineSegments } from 'three'
import Game from '../Game'

export class RapierDebugRenderer {
  mesh
  world
  enabled

  stats = {
    bodies: 0,
    colliders: 0,
    active: 0,
  }

  constructor(scene: Scene, world: RAPIER.World, enabled = false) {
    this.world = world
    this.mesh = new LineSegments(new BufferGeometry(), new LineBasicMaterial({ color: 0xFFFFFF, vertexColors: true }))
    this.mesh.frustumCulled = false
    this.enabled = enabled
    scene.add(this.mesh)

    const physicsPane = Game.instance().debug.ui?.addFolder({
      title: 'Physics',
    })

    if (physicsPane) {
      physicsPane.addBinding(this.stats, 'bodies', { label: 'Bodies', readonly: true })
      physicsPane.addBinding(this.stats, 'colliders', { label: 'Colliders', readonly: true })
      physicsPane.addBinding(this.stats, 'active', { label: 'Active', readonly: true })

      this.toggleVisible(true)
    }
  }

  toggleVisible(visible: boolean) {
    this.enabled = visible
  }

  update() {
    if (this.enabled) {
      const { vertices, colors } = this.world.debugRender()
      this.mesh.geometry.setAttribute('position', new BufferAttribute(vertices, 3))
      this.mesh.geometry.setAttribute('color', new BufferAttribute(colors, 4))
      this.mesh.visible = true

      this.stats.bodies = 0
      this.stats.active = 0

      this.stats.colliders = this.world.colliders.len()

      this.world.bodies.forEach((body) => {
        this.stats.bodies++

        if (!body.isSleeping() && body.isEnabled()) {
          this.stats.active++
        }
      })
    }
    else {
      this.mesh.visible = false
    }
  }
}
