import { unzlibSync, zlibSync } from 'three/examples/jsm/libs/fflate.module.js'

/*
 * Binary data in scene files: deflated, then base64, so a heightmap, a splatmap or a few thousand scattered instances
 * fit in a prop of the scene's JSON. Synchronous and without Node or DOM APIs beyond atob / btoa, so the client, the
 * server and the tests read the same bytes.
 */

const CHUNK = 0x8000

function toBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let i = 0; i < bytes.length; i += CHUNK)
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  return btoa(binary)
}

function fromBase64(text: string): Uint8Array {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++)
    bytes[i] = binary.charCodeAt(i)
  return bytes
}

export function encodeBytes(bytes: Uint8Array): string {
  return toBase64(zlibSync(bytes, { level: 6 }))
}

/** Throws when `text` isn't what `encodeBytes()` wrote */
export function decodeBytes(text: string): Uint8Array {
  return unzlibSync(fromBase64(text))
}

export function encodeFloat32(values: Float32Array): string {
  return encodeBytes(new Uint8Array(values.buffer, values.byteOffset, values.byteLength))
}

/** Throws when `text` isn't what `encodeFloat32()` wrote */
export function decodeFloat32(text: string): Float32Array {
  const bytes = decodeBytes(text)
  if (bytes.byteLength % 4)
    throw new Error('Not a list of 32 bit floats')
  // Copied: the inflated bytes may not start on a 4 byte boundary
  return new Float32Array(bytes.slice().buffer)
}

/** Small seeded PRNG (mulberry32): the same seed gives the same numbers on every side */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6D2B79F5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
