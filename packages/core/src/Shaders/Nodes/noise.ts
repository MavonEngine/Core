import type { Node } from 'three/webgpu'
import {
  abs,
  dot,
  float,
  floatBitsToUint,
  floor,
  Fn,
  fract,
  mix,
  mod,
  smoothstep,
  step,
  uint,
  uintBitsToFloat,
  vec2,
  vec3,
  vec4,
} from 'three/tsl'

/*
 * Noise functions for TSL materials, ported from the engine's former GLSL shaders.
 * They are plain TSL functions: call them with nodes, e.g. `perlinNoise3D(positionWorld)`.
 */

const permute = (x: Node<'vec4'>) => mod(x.mul(34).add(1).mul(x), 289)
const taylorInvSqrt = (r: Node<'vec4'>) => float(1.79284291400159).sub(r.mul(0.85373472095314))
const fade = (t: Node<'vec3'>) => t.mul(t).mul(t).mul(t.mul(t.mul(6).sub(15)).add(10))

/**
 * Classic Perlin 3D noise by Stefan Gustavson, roughly -1 .. 1
 */
export const perlinNoise3D = /* @__PURE__ */ Fn(([P]: [Node<'vec3'>]) => {
  const Pi0 = mod(floor(P), 289).toVar()
  const Pi1 = mod(floor(P).add(1), 289).toVar()
  const Pf0 = fract(P).toVar()
  const Pf1 = Pf0.sub(1).toVar()
  const ix = vec4(Pi0.x, Pi1.x, Pi0.x, Pi1.x)
  const iy = vec4(Pi0.y, Pi0.y, Pi1.y, Pi1.y)
  const iz0 = vec4(Pi0.z)
  const iz1 = vec4(Pi1.z)

  const ixy = permute(permute(ix).add(iy)).toVar()
  const ixy0 = permute(ixy.add(iz0)).toVar()
  const ixy1 = permute(ixy.add(iz1)).toVar()

  const gradients = (ixyN: Node<'vec4'>) => {
    const gx = ixyN.div(7).toVar()
    const gy = fract(floor(gx).div(7)).sub(0.5).toVar()
    gx.assign(fract(gx))
    const gz = vec4(0.5).sub(abs(gx)).sub(abs(gy)).toVar()
    const sz = step(gz, vec4(0))
    gx.subAssign(sz.mul(step(0, gx).sub(0.5)))
    gy.subAssign(sz.mul(step(0, gy).sub(0.5)))
    return { gx, gy, gz }
  }

  const g0 = gradients(ixy0)
  const g1 = gradients(ixy1)

  const g000 = vec3(g0.gx.x, g0.gy.x, g0.gz.x).toVar()
  const g100 = vec3(g0.gx.y, g0.gy.y, g0.gz.y).toVar()
  const g010 = vec3(g0.gx.z, g0.gy.z, g0.gz.z).toVar()
  const g110 = vec3(g0.gx.w, g0.gy.w, g0.gz.w).toVar()
  const g001 = vec3(g1.gx.x, g1.gy.x, g1.gz.x).toVar()
  const g101 = vec3(g1.gx.y, g1.gy.y, g1.gz.y).toVar()
  const g011 = vec3(g1.gx.z, g1.gy.z, g1.gz.z).toVar()
  const g111 = vec3(g1.gx.w, g1.gy.w, g1.gz.w).toVar()

  const norm0 = taylorInvSqrt(vec4(dot(g000, g000), dot(g010, g010), dot(g100, g100), dot(g110, g110))).toVar()
  g000.mulAssign(norm0.x)
  g010.mulAssign(norm0.y)
  g100.mulAssign(norm0.z)
  g110.mulAssign(norm0.w)
  const norm1 = taylorInvSqrt(vec4(dot(g001, g001), dot(g011, g011), dot(g101, g101), dot(g111, g111))).toVar()
  g001.mulAssign(norm1.x)
  g011.mulAssign(norm1.y)
  g101.mulAssign(norm1.z)
  g111.mulAssign(norm1.w)

  const n000 = dot(g000, Pf0)
  const n100 = dot(g100, vec3(Pf1.x, Pf0.y, Pf0.z))
  const n010 = dot(g010, vec3(Pf0.x, Pf1.y, Pf0.z))
  const n110 = dot(g110, vec3(Pf1.x, Pf1.y, Pf0.z))
  const n001 = dot(g001, vec3(Pf0.x, Pf0.y, Pf1.z))
  const n101 = dot(g101, vec3(Pf1.x, Pf0.y, Pf1.z))
  const n011 = dot(g011, vec3(Pf0.x, Pf1.y, Pf1.z))
  const n111 = dot(g111, Pf1)

  const fadeXyz = fade(Pf0).toVar()
  const nZ = mix(vec4(n000, n100, n010, n110), vec4(n001, n101, n011, n111), fadeXyz.z).toVar()
  const nYz = mix(nZ.xy, nZ.zw, fadeXyz.y).toVar()
  return mix(nYz.x, nYz.y, fadeXyz.x).mul(2.2)
}).setLayout({
  name: 'perlinNoise3D',
  type: 'float',
  inputs: [
    { name: 'P', type: 'vec3' },
  ],
})

function murmurMix(v: Node<'uint'>, M: Node<'uint'>) {
  const x = v.mul(M).toVar()
  x.assign(x.bitXor(x.shiftRight(24)))
  return x.mul(M)
}

const murmurHash12 = /* @__PURE__ */ Fn(([srcX, srcY]: [Node<'uint'>, Node<'uint'>]) => {
  const M = uint(0x5BD1E995)
  const h = uint(1190494759).mul(M).toVar()
  h.assign(h.bitXor(murmurMix(srcX, M)).mul(M))
  h.assign(h.bitXor(murmurMix(srcY, M)))
  h.assign(h.bitXor(h.shiftRight(13)).mul(M))
  h.assign(h.bitXor(h.shiftRight(15)))
  return h
}).setLayout({
  name: 'murmurHash12',
  type: 'uint',
  inputs: [
    { name: 'srcX', type: 'uint' },
    { name: 'srcY', type: 'uint' },
  ],
})

/** A hash of a 2D point: 0 .. 1 */
export const hash12 = /* @__PURE__ */ Fn(([src]: [Node<'vec2'>]) => {
  // The typings have bitcasts take and return untyped nodes
  const bits = (v: Node) => floatBitsToUint(v) as unknown as Node<'uint'>
  const h = murmurHash12(bits(src.x), bits(src.y))
  const mantissa = h.bitAnd(uint(0x007FFFFF)).bitOr(uint(0x3F800000))
  return (uintBitsToFloat(mantissa as unknown as Node) as unknown as Node<'float'>).sub(1)
}).setLayout({
  name: 'hash12',
  type: 'float',
  inputs: [
    { name: 'src', type: 'vec2' },
  ],
})

/** Smooth 2D value noise: -1 .. 1 */
export const valueNoise2D = /* @__PURE__ */ Fn(([p]: [Node<'vec2'>]) => {
  const i = floor(p).toVar()
  const f = fract(p)
  const u = smoothstep(vec2(0), vec2(1), f).toVar()

  const val = mix(
    mix(hash12(i), hash12(i.add(vec2(1, 0))), u.x),
    mix(hash12(i.add(vec2(0, 1))), hash12(i.add(vec2(1, 1))), u.x),
    u.y,
  )
  return val.mul(2).sub(1)
}).setLayout({
  name: 'valueNoise2D',
  type: 'float',
  inputs: [
    { name: 'p', type: 'vec2' },
  ],
})
