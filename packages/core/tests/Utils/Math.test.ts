import { describe, expect, it } from 'vitest'
import { randomSigned, randRange } from '../../src/Utils/Math'

describe('math helpers', () => {
  it('randomSigned returns value between -1 and 1', () => {
    for (let i = 0; i < 10; i++) {
      const v = randomSigned()
      expect(v).toBeLessThanOrEqual(1)
      expect(v).toBeGreaterThan(-1)
    }
  })

  it('randRange returns value within range', () => {
    for (let i = 0; i < 10; i++) {
      const v = randRange(2, 5)
      expect(v).toBeGreaterThanOrEqual(2)
      expect(v).toBeLessThan(5)
    }
  })
})
