/**
 * Generates a random floating-point number between -1 and 1.
 *
 * The function multiplies a random number between 0 and 1 by either -1 or 1,
 * randomly choosing the sign with equal probability.
 *
 * @returns {number} A random number in the range [-1, 1).
 */
export function randomSigned() {
  return Math.random() * (Math.random() < 0.5 ? -1 : 1)
}

export function randRange(min: number, max: number): number {
  return Math.random() * (max - min) + min
}
