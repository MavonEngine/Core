import type { Node } from 'three/webgpu'
import { distance, float, Loop, max, select, smoothstep, uniformArray } from 'three/tsl'
import { Vector3 } from 'three/webgpu'

/**
 * Points that push into a surface (grass bending under the player, ripples on water): their positions and radii as
 * uniform arrays, read every frame.
 */
export class PushPoints {
  readonly positions: Vector3[]
  readonly radii: number[]
  readonly positionsNode
  readonly radiiNode

  constructor(readonly count: number) {
    this.positions = Array.from({ length: count }, () => new Vector3())
    this.radii = Array.from<number>({ length: count }).fill(0)
    this.positionsNode = uniformArray(this.positions, 'vec3')
    this.radiiNode = uniformArray(this.radii, 'float')
  }

  /** Copy in up to `count` points. Slots past the given points keep what they held */
  set(points: { position: Vector3, radius: number }[]) {
    const n = Math.min(points.length, this.count)
    for (let i = 0; i < n; i++) {
      this.positions[i]!.copy(points[i]!.position)
      this.radii[i] = points[i]!.radius
    }
  }

  /**
   * Calls `each(influence, dist)` for every point, where influence is 1 at the point and 0 at its radius, measured on
   * the xz plane from `worldPos`
   */
  forEach(worldPos: Node<'vec3'>, each: (influence: Node<'float'>, dist: Node<'float'>) => void) {
    Loop(this.count, ({ i }: { i: Node<'int'> }) => {
      const radius = this.radiiNode.element(i) as unknown as Node<'float'>
      const dist = distance(worldPos.xz, (this.positionsNode.element(i) as unknown as Node<'vec3'>).xz)
      // An unused slot (radius 0) has none: smoothstep with both edges at 0 divides by zero, which GPUs read as 1
      const influence = select(radius.greaterThan(0), smoothstep(radius, 0, dist), float(0))
      each(influence, dist)
    })
  }

  /** The strongest influence of any point on `worldPos`: 0 .. 1 */
  maxInfluence(worldPos: Node<'vec3'>): Node<'float'> {
    const total = float(0).toVar()
    this.forEach(worldPos, influence => total.assign(max(total, influence)))
    return total
  }
}
