import { Vector3 } from 'three'
import { describe, expect, it } from 'vitest'
import NetworkedGameObject from '../../src/Networking/NetworkedGameObject'

class TestNetworkedGameObject extends NetworkedGameObject {
  $typeName = 'test'
  update(_delta: number): void { }
}

describe('networkedGameObject', () => {
  describe('updateFromNetwork', () => {
    it('updates position from network data', () => {
      const obj = new TestNetworkedGameObject()
      expect(obj.position).toStrictEqual(new Vector3())

      obj.updateFromNetwork({ position: new Vector3(1, 2, 3) })
      expect(obj.position).toStrictEqual(new Vector3(1, 2, 3))
    })

    it('updates rotation from network data', () => {
      const obj = new TestNetworkedGameObject()
      expect(obj.rotation).toStrictEqual(new Vector3())

      obj.updateFromNetwork({ rotation: new Vector3(0.1, 0.2, 0.3) })
      expect(obj.rotation).toStrictEqual(new Vector3(0.1, 0.2, 0.3))
    })

    it('updates scale from network data', () => {
      const obj = new TestNetworkedGameObject()

      obj.updateFromNetwork({ scale: new Vector3(2, 2, 2) })
      expect(obj.scale).toStrictEqual(new Vector3(2, 2, 2))
    })

    it('updates multiple fields at once', () => {
      const obj = new TestNetworkedGameObject()
      obj.updateFromNetwork({ position: new Vector3(10, 20, 30), rotation: new Vector3(1, 0, 0), scale: new Vector3(3, 3, 3) })
      expect(obj.position).toStrictEqual(new Vector3(10, 20, 30))
      expect(obj.rotation).toStrictEqual(new Vector3(1, 0, 0))
      expect(obj.scale).toStrictEqual(new Vector3(3, 3, 3))
    })

    it('preserves the original Vector3 instance reference', () => {
      const obj = new TestNetworkedGameObject()
      const originalPos = obj.position
      obj.updateFromNetwork({ position: new Vector3(5, 6, 7) })
      expect(obj.position).toBe(originalPos)
    })

    it('ignores unknown fields in network data', () => {
      const obj = new TestNetworkedGameObject()
      const originalPos = obj.position
      expect(() => obj.updateFromNetwork({ unknown: 'value' })).not.toThrow()
      expect(obj.position).toBe(originalPos)
    })
  })

  describe('subclass networkedFieldCallbacks override', () => {
    it('applies custom callback fields from subclass', () => {
      class ExtendedObject extends NetworkedGameObject {
        $typeName = 'extended'
        health = 100
        update(_delta: number): void { }

        networkedFieldCallbacks(): Record<string, (value: unknown) => void> {
          return {
            ...super.networkedFieldCallbacks(),
            health: (v) => { this.health = v as number },
          }
        }
      }

      const obj = new ExtendedObject()
      obj.updateFromNetwork({ health: 75 })
      expect(obj.health).toBe(75)
    })
  })
})
