import type { SceneObjectData } from '@mavonengine/core/Scene/types'
import type { SV_TREES } from '../../Commands/Server'
import GameObject from '@mavonengine/core/World/GameObject'
import { Vector3 } from 'three'
import Tree from './Tree'

/** Scene object type of a tree field, see scenes/main.json */
export const TREE_FIELD_TYPE = 'TreeField'

export interface TreeFieldProps {
  /** How many trees */
  count: number
  /** Trees are placed within ±area of the field's position on x and z */
  area: number
  minScale: number
  maxScale: number
  /** Same seed, same trees. Change it in the editor to reshuffle */
  seed: number
}

const DEFAULTS: TreeFieldProps = { count: 15, area: 80, minScale: 0.01, maxScale: 0.015, seed: 1 }

/** Small seeded PRNG (mulberry32), so the server places the same trees on every start */
function seededRandom(seed: number) {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * The server side of a tree field in the scene: a collider per tree, and the placement it sends to the
 * clients as SV_TREES. The client has no factory for it; it renders what the server sends (World/Trees.ts).
 */
export default class TreeField extends GameObject {
  readonly props: TreeFieldProps
  private trees: Tree[] = []
  private positions: number[] = []
  private rotations: number[] = []
  private scales: number[] = []

  constructor(data: SceneObjectData) {
    super(data.id, new Vector3(...data.transform.position))
    this.props = { ...DEFAULTS, ...(data.props as Partial<TreeFieldProps>) }

    const { count, area, minScale, maxScale, seed } = this.props
    const random = seededRandom(seed)
    const range = (min: number, max: number) => min + random() * (max - min)

    for (let i = 0; i < count; i++) {
      const x = this.position.x + range(-area, area)
      const z = this.position.z + range(-area, area)
      const y = this.position.y
      const rotY = random() * Math.PI * 2
      const scale = range(minScale, maxScale)

      this.trees.push(new Tree(new Vector3(x, y, z)))
      this.positions.push(x, y, z)
      this.rotations.push(0, rotY, 0)
      this.scales.push(scale, scale, scale)
    }
  }

  /** Placement of every tree, for SV_TREES */
  get packet(): SV_TREES {
    return { positions: this.positions, rotations: this.rotations, scales: this.scales }
  }

  update(_delta: number): void {}

  destroy(): void {
    this.trees.forEach(tree => tree.destroy())
    this.trees = []
    super.destroy()
  }
}
