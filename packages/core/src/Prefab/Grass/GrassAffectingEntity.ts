import type { Vector3 } from 'three'

export default interface GrassAffectingEntity {
  getPushPoints(): { position: Vector3, radius: number }[]
}

export function isGrassAffectingEntity(obj: any): obj is GrassAffectingEntity {
  return typeof obj.getPushPoints === 'function'
}
