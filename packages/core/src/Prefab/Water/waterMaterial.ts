import type { Node } from 'three/webgpu'
import type { PushPoints } from '../../Shaders/Nodes/pushPoints'
import {
  abs,
  cameraPosition,
  cross,
  dFdx,
  dFdy,
  dot,
  float,
  Fn,
  Loop,
  max,
  mix,
  modelWorldMatrix,
  modelWorldMatrixInverse,
  normalize,
  positionLocal,
  pow,
  sin,
  uniform,
  varying,
  vec3,
  vec4,
} from 'three/tsl'
import { Color, EqualStencilFunc, IncrementStencilOp, MeshBasicNodeMaterial, Vector2, Vector3 } from 'three/webgpu'
import { perlinNoise3D } from '../../Shaders/Nodes/noise'

export function createWaterUniforms() {
  return {
    uTime: uniform(0),

    uBigWavesElevation: uniform(0.380),
    uBigWavesFrequency: uniform(new Vector2(0.326, 0.978)),
    uBigWavesSpeed: uniform(1.0),

    uDepthColor: uniform(new Color('#186691')),
    uSurfaceColor: uniform(new Color('#9bd8ff')),
    uColorOffset: uniform(0.380),
    uColorMultiplier: uniform(0.761),

    uSunDirection: uniform(new Vector3(0, 1, 0)),
    uSunReflectionStrength: uniform(1.0),
  }
}

export type WaterUniforms = ReturnType<typeof createWaterUniforms>

/**
 * The sea: two crossing sine waves with Perlin noise chop and ripples around the push points, colored by height and
 * lit by the sun (Blinn-Phong and Fresnel).
 * https://threejs-journey.com/lessons/raging-sea
 */
export function createWaterMaterial(u: WaterUniforms, push: PushPoints): MeshBasicNodeMaterial {
  const material = new MeshBasicNodeMaterial({
    transparent: true,
    fog: false,
    stencilWrite: true,
    stencilFunc: EqualStencilFunc,
    stencilRef: 0,
    stencilZPass: IncrementStencilOp,
  })

  const ripple = (worldPos: Node<'vec3'>) => {
    const total = float(0).toVar()
    push.forEach(worldPos, (influence, dist) => {
      // Expanding ring ripple pattern
      total.addAssign(sin(dist.mul(8).sub(u.uTime.mul(4))).mul(influence))
    })
    return total
  }

  const elevation = Fn(() => {
    const modelPosition = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz.toVar()

    const result = sin(modelPosition.x.mul(u.uBigWavesFrequency.x).add(u.uTime.mul(u.uBigWavesSpeed)))
      .mul(sin(modelPosition.z.mul(u.uBigWavesFrequency.y).add(u.uTime.mul(u.uBigWavesSpeed))))
      .mul(u.uBigWavesElevation)
      .toVar()

    Loop({
      start: 1,
      end: 4,
      type: 'float',
      condition: '<=',
    }, ({ i }: { i: Node<'float'> }) => {
      const noise = perlinNoise3D(vec3(modelPosition.xz.mul(3).mul(i), u.uTime.mul(0.2)))
      result.subAssign(abs(noise).mul(0.15).div(i))
    })

    // Player ripples
    result.addAssign(ripple(modelPosition).mul(0.2))
    return result
  })()

  // Computed once per vertex, read per pixel
  const vElevation = varying(elevation)
  const worldPosition = modelWorldMatrix.mul(vec4(positionLocal, 1)).xyz.add(vec3(0, elevation, 0))
  const vWorldPosition = varying(worldPosition)

  // The elevation is in world space (y up), so it's lifted there and taken back into the mesh's space
  material.positionNode = modelWorldMatrixInverse.mul(vec4(worldPosition, 1)).xyz

  material.colorNode = Fn(() => {
    const mixStrength = vElevation.add(u.uColorOffset).mul(u.uColorMultiplier)
    const color = mix(u.uDepthColor, u.uSurfaceColor, mixStrength).toVar()

    // Sun reflection, with the normal from the surface's slope on screen
    const normal = normalize(cross(dFdx(vWorldPosition), dFdy(vWorldPosition)))
    const viewDir = normalize(cameraPosition.sub(vWorldPosition))
    const sunDir = normalize(u.uSunDirection)

    // Specular highlight (Blinn-Phong)
    const halfDir = normalize(sunDir.add(viewDir))
    const spec = pow(max(dot(normal, halfDir), 0), 128)

    // Fresnel: stronger reflections at grazing angles
    const fresnel = pow(float(1).sub(max(dot(normal, viewDir), 0)), 3)

    const sunColor = vec3(1.0, 0.95, 0.8)
    color.addAssign(sunColor.mul(spec).mul(fresnel.mul(0.5).add(0.5)).mul(u.uSunReflectionStrength))

    return vec4(color, 0.9)
  })()

  return material
}
