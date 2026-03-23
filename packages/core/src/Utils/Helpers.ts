import { Vector3 } from 'three'

/**
 * An easy way to iterate through a Float32Array
 * and get xyz values out
 */
export function* xyzIterator(arr: Float32Array) {
  for (let i = 0; i < arr.length; i += 3) {
    yield new Vector3(arr[i], arr[i + 1], arr[i + 2])
  }
}
