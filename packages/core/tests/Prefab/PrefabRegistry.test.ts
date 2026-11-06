import { Vector3 } from 'three'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { getPrefab, getPrefabs, prefabKey, registerPrefab, spawnPrefab, unregisterPrefab } from '../../src/Prefab/PrefabRegistry'

const keys: string[] = []

function register(prefab: Parameters<typeof registerPrefab>[0]) {
  registerPrefab(prefab)
  keys.push(prefabKey(prefab))
}

afterEach(() => {
  keys.splice(0).forEach(unregisterPrefab)
})

describe('prefabRegistry', () => {
  it('keys plugin prefabs by plugin so names can repeat', () => {
    register({ name: 'Tree', spawn: vi.fn() })
    register({ name: 'Tree', plugin: 'forest', spawn: vi.fn() })

    expect(getPrefab('Tree')?.plugin).toBeUndefined()
    expect(getPrefab('forest:Tree')?.plugin).toBe('forest')
  })

  it('lists built-in prefabs first, then plugin prefabs grouped by plugin', () => {
    register({ name: 'Rock', plugin: 'stones', spawn: vi.fn() })
    register({ name: 'Water', spawn: vi.fn() })
    register({ name: 'Tree', plugin: 'forest', spawn: vi.fn() })
    register({ name: 'Bush', plugin: 'forest', spawn: vi.fn() })

    expect(getPrefabs().map(p => p.key)).toEqual(['Water', 'forest:Tree', 'forest:Bush', 'stones:Rock'])
  })

  it('spawns at the position and treats no return value as created', () => {
    const spawn = vi.fn()
    register({ name: 'Tree', plugin: 'forest', spawn })
    const position = new Vector3(1, 2, 3)

    expect(spawnPrefab('forest:Tree', position)).toEqual({})
    expect(spawn).toHaveBeenCalledWith(position)
  })

  it('returns null for unknown prefabs and ones that decline to spawn', () => {
    register({ name: 'Grass', spawn: () => null })

    expect(spawnPrefab('Grass', new Vector3())).toBeNull()
    expect(spawnPrefab('nope', new Vector3())).toBeNull()
  })
})
