import { beforeEach, describe, expect, it } from 'vitest'
import NetworkedActor from '../../src/Networking/NetworkedActor'
import NetworkedEntityFactory from '../../src/Networking/NetworkedEntityFactory'

class TestActor extends NetworkedActor {
  $typeName = 'testActor'
  updateFromNetwork = (_data: object) => { }
  update(_delta: number): void { }
}

describe('networkedEntityFactory', () => {
  let factory: NetworkedEntityFactory

  beforeEach(() => {
    factory = new NetworkedEntityFactory()
  })

  it('returns null for an unregistered type', () => {
    expect(factory.create('unknown', { id: 'id-1' })).toBeNull()
  })

  it('creates a registered entity', () => {
    factory.register('testActor', (data) => {
      const actor = new TestActor()
      actor.id = data.id as string
      return actor
    })

    const actor = factory.create('testActor', { id: 'id-1' })
    expect(actor).toBeInstanceOf(TestActor)
  })

  it('passes id and data to the factory function', () => {
    const data = { x: 10, y: 20, id: 'id-42' }
    let capturedId: string | undefined
    let capturedData: Record<string, unknown> | undefined

    factory.register('testActor', (data) => {
      capturedId = data.id as string
      capturedData = data
      return new TestActor()
    })

    factory.create('testActor', data)
    expect(capturedId).toBe('id-42')
    expect(capturedData).toEqual(data)
  })

  it('overwrites a previously registered factory', () => {
    factory.register('testActor', () => {
      const a = new TestActor()
      a.$typeName = 'first'
      return a
    })
    factory.register('testActor', () => {
      const a = new TestActor()
      a.$typeName = 'second'
      return a
    })

    const actor = factory.create('testActor', 'id-1', {}) as TestActor
    expect(actor.$typeName).toBe('second')
  })

  it('handles multiple registered types independently', () => {
    class OtherActor extends NetworkedActor {
      $typeName = 'otherActor'
      updateFromNetwork = (_data: object) => { }
      update(_delta: number): void { }
    }

    factory.register('testActor', () => new TestActor())
    factory.register('otherActor', () => new OtherActor())

    expect(factory.create('testActor', 'id-1', {})).toBeInstanceOf(TestActor)
    expect(factory.create('otherActor', 'id-2', {})).toBeInstanceOf(OtherActor)
  })
})
