import type { GraphValue } from '../types'

/*
 * Arithmetic on graph values for `eval` implementations: numbers and vectors (arrays), component wise, a number
 * spreading over every component like in a shader.
 */

export type NumberValue = number | number[]

export function asNumber(value: GraphValue | undefined): NumberValue {
  if (typeof value === 'number')
    return value
  if (typeof value === 'boolean')
    return value ? 1 : 0
  if (Array.isArray(value))
    return value
  return 0
}

/** The first component */
export function asFloat(value: GraphValue | undefined): number {
  const n = asNumber(value)
  return Array.isArray(n)
    ? n[0] ?? 0
    : n
}

/** Apply `fn` per component across the arguments, as wide as the widest of them */
export function componentWise(fn: (...args: number[]) => number, ...args: (GraphValue | undefined)[]): NumberValue {
  const values = args.map(asNumber)
  const width = Math.max(0, ...values.map(v => Array.isArray(v)
    ? v.length
    : 0))
  if (width === 0)
    return fn(...(values as number[]))
  return Array.from({ length: width }, (_, i) => fn(...values.map(v => Array.isArray(v)
    ? v[i] ?? 0
    : v)))
}

export function asVector(value: GraphValue | undefined, size: number): number[] {
  const n = asNumber(value)
  return Array.from({ length: size }, (_, i) => Array.isArray(n)
    ? n[i] ?? 0
    : n)
}

export function dot(a: GraphValue | undefined, b: GraphValue | undefined): number {
  const x = asNumber(a)
  const y = asNumber(b)
  const width = Math.max(Array.isArray(x)
    ? x.length
    : 1, Array.isArray(y)
    ? y.length
    : 1)
  const av = asVector(x, width)
  const bv = asVector(y, width)
  return av.reduce((sum, v, i) => sum + v * bv[i]!, 0)
}

export function length(value: GraphValue | undefined): number {
  return Math.sqrt(dot(value, value))
}

export function clamp(x: number, min: number, max: number): number {
  return Math.min(Math.max(x, min), max)
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) {
    return x < edge0
      ? 0
      : 1
  }
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}

/** x - floor(x), always 0 .. 1 like GLSL's fract */
export function fract(x: number): number {
  return x - Math.floor(x)
}
