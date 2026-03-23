import { describe, expect, it } from 'vitest'
import GameObject from '../../src/World/GameObject'

class DummyGameObject extends GameObject {
  update(_delta: number): void {
    throw new Error('Method not implemented.')
  }
}

describe('gameObject', () => {
  it('serializes id, position and rotation', () => {
    const obj = new DummyGameObject('id1')
    const data = (obj as any).serialize()
    expect(data.id).toBe('id1')
    expect(data.position).toBe(obj.position)
    expect(data.rotation).toBe(obj.rotation)
  })

  it('sets garbageCollect flag on destroy', () => {
    const obj = new DummyGameObject('id2')
    obj.destroy()
    expect(obj.garbageCollect).toBe(true)
  })
})
