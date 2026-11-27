import type { PushPoints } from '../../Shaders/Nodes/pushPoints'
import { attribute, cos, float, Fn, mat3, mix, modelWorldMatrix, pow, sin, uniform, uv, vec2, vec3, vec4 } from 'three/tsl'
import { DoubleSide, MeshBasicNodeMaterial } from 'three/webgpu'
import { valueNoise2D } from '../../Shaders/Nodes/noise'

export interface GrassUniforms {
  uTime: ReturnType<typeof uniform<'float'>>
}

export function createGrassUniforms(): GrassUniforms {
  return {
    uTime: uniform(0),
  }
}

/**
 * The grass blades: bent by wind, a random lean and the push points (pushed flat), colored from base to tip.
 * Reads the instanced attributes `offset`, `rotationAngle`, `instanceScale` and `randomLean`.
 */
export function createGrassMaterial(push: PushPoints, uniforms: GrassUniforms): MeshBasicNodeMaterial {
  const { uTime } = uniforms

  const material = new MeshBasicNodeMaterial({ side: DoubleSide, fog: false })

  material.positionNode = Fn(() => {
    const offset = attribute('offset', 'vec3')
    const rotationAngle = attribute('rotationAngle', 'float')
    const instanceScale = attribute('instanceScale', 'float')
    const randomLean = attribute('randomLean', 'float')

    // Local transformation: scale blade by instanceScale
    const centered = attribute('position', 'vec3').toVar()
    centered.y.mulAssign(instanceScale)

    // Wind direction from noise
    const windSpeed = 1.0
    const windStrength = valueNoise2D(offset.xz.mul(0.4).add(vec2(uTime.mul(windSpeed))))
    const windAngle = windStrength.mul(0.3 * Math.PI)
    const windDir = vec2(cos(windAngle), sin(windAngle)).toVar()

    const leanFactor = centered.y.toVar()

    // Pushed down around the push points
    const worldInstancePos = modelWorldMatrix.mul(vec4(offset, 1)).xyz
    const pushInfluence = push.maxInfluence(worldInstancePos)

    // Bending that increases with height
    const heightBendFactor = pow(centered.y, 1.5)
    const bendAmount = randomLean.add(windDir.x).mul(heightBendFactor).mul(0.8)
    const pushBend = pushInfluence.mul(leanFactor)

    centered.x.addAssign(bendAmount)
    centered.z.addAssign(windDir.y.mul(leanFactor).mul(0.2))
    centered.y.subAssign(pushBend)

    const c = cos(rotationAngle)
    const s = sin(rotationAngle)
    // Column major, like GLSL's mat3(...)
    const rotationY = mat3(
      c,
      float(0),
      s,
      float(0),
      float(1),
      float(0),
      s.negate(),
      float(0),
      c,
    )

    return rotationY.mul(centered).add(offset)
  })()

  const baseColor = vec3(0.05, 0.2, 0.01)
  const tipColor = vec3(0.5, 0.5, 0.1)
  material.colorNode = vec4(mix(tipColor, baseColor, uv().y), 1)

  return material
}
