import type {
  Vector3,
} from 'three'
import type GameObject from '../World/GameObject'
import type GameObjectInterface from '../World/GameObjectInterface'
import {
  BufferGeometry,
  Float32BufferAttribute,
  Line,
  LineBasicMaterial,
  Points,
  PointsMaterial,
} from 'three'
import Game from '../Game'

interface TimedPoint {
  position: Vector3
  timestamp: number // in seconds (relative to game time)
}

/**
 * Creates a trail behind the entity
 */
export default class TrailComponent implements GameObjectInterface {
  entity: GameObject
  points: TimedPoint[] = []

  geometry?: BufferGeometry
  lineGeometry?: BufferGeometry

  pointsInstance?: Points
  lineInstance?: Line

  maxPoints: number

  constructor(entity: GameObject, maxPoints: number = 50) {
    this.entity = entity
    this.maxPoints = maxPoints

    const startPos = entity.position.clone()
    this.points.push({
      position: startPos,
      timestamp: Game.instance().clock.getElapsedTime() ?? 0,
    })

    if (Game.instance().debug.active) {
      // Create Points
      this.geometry = new BufferGeometry()
      this.geometry.setAttribute('position', new Float32BufferAttribute(startPos.toArray(), 3))

      const pointsMaterial = new PointsMaterial({ size: 0.1, color: 0xFFFFFF })
      this.pointsInstance = new Points(this.geometry, pointsMaterial)
      this.pointsInstance.frustumCulled = false
      Game.instance().scene.add(this.pointsInstance)

      // Create Line
      this.lineGeometry = new BufferGeometry()
      this.lineGeometry.setAttribute('position', new Float32BufferAttribute(startPos.toArray(), 3))

      const lineMaterial = new LineBasicMaterial({ color: 0xFF0000 })
      this.lineInstance = new Line(this.lineGeometry, lineMaterial)
      this.lineInstance.frustumCulled = false
      Game.instance().scene.add(this.lineInstance)
    }
  }

  update(_delta: number) {
    const lastPoint = this.points.at(-1)
    const currentPosition = this.entity.position

    if (currentPosition.distanceTo(lastPoint.position) >= 1) {
      const newPoint = currentPosition.clone()
      this.points.push({
        position: newPoint,
        timestamp: Game.instance().clock.getElapsedTime() ?? 0,
      })

      if (this.points.length > this.maxPoints) {
        this.points.shift()
      }

      const positions = new Float32Array(this.points.length * 3)
      for (let i = 0; i < this.points.length; i++) {
        positions[i * 3] = this.points[i].position.x
        positions[i * 3 + 1] = this.points[i].position.y
        positions[i * 3 + 2] = this.points[i].position.z
      }

      if (this.geometry) {
        this.geometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
        this.geometry.attributes.position.needsUpdate = true
      }

      if (this.lineGeometry) {
        this.lineGeometry.setAttribute('position', new Float32BufferAttribute(positions, 3))
        this.lineGeometry.attributes.position.needsUpdate = true
      }
    }
  }

  destroy() {
    if (this.pointsInstance) {
      Game.instance().scene.remove(this.pointsInstance)
      this.geometry?.dispose();
      (this.pointsInstance.material as PointsMaterial).dispose()
    }

    if (this.lineInstance) {
      Game.instance().scene.remove(this.lineInstance)
      this.lineGeometry?.dispose();
      (this.lineInstance.material as LineBasicMaterial).dispose()
    }
  }
}
