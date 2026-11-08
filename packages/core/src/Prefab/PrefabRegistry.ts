import type { ContainerApi } from '@tweakpane/core'
import type { Vector3 } from 'three'
import type GameObject from '../World/GameObject'

export interface PrefabSpawnResult {
  /** Added to the world under a generated key */
  object?: GameObject
  /** Shown as a pane in the editor's properties panel */
  addBindings?(folder: ContainerApi): void
  /** Clear the existing prefab panes before adding this one */
  clearPanes?: boolean
}

export interface PrefabDefinition {
  name: string
  /** Shown in the editor. Defaults to `name` */
  label?: string
  /** npm package of the plugin that registered it, unset for built-in prefabs */
  plugin?: string
  /** SVG markup or an image URL for the editor's asset list */
  icon?: string
  /**
   * Create the prefab at `position`. Return null when it can't be created right now (log why);
   * nothing is recorded as used then. Returning nothing counts as created.
   */
  spawn(position: Vector3): PrefabSpawnResult | void | null
}

const registry = new Map<string, PrefabDefinition>()

export function prefabKey(prefab: Pick<PrefabDefinition, 'name' | 'plugin'>): string {
  return prefab.plugin ? `${prefab.plugin}:${prefab.name}` : prefab.name
}

/**
 * Make a prefab available in the editor. Registering the same name again replaces it.
 */
export function registerPrefab(prefab: PrefabDefinition): void {
  registry.set(prefabKey(prefab), prefab)
}

export function unregisterPrefab(key: string): void {
  registry.delete(key)
}

/** Built-in prefabs first, then plugin prefabs grouped by plugin, each in registration order */
export function getPrefabs(): (PrefabDefinition & { key: string })[] {
  const all = Array.from(registry.entries(), ([key, prefab]) => ({ ...prefab, key }))
  return [...all.filter(p => !p.plugin), ...all.filter(p => p.plugin).sort((a, b) => a.plugin!.localeCompare(b.plugin!))]
}

export function getPrefab(key: string): PrefabDefinition | undefined {
  return registry.get(key)
}

/**
 * Spawn a registered prefab. Returns null when it is unknown or declined to spawn.
 */
export function spawnPrefab(key: string, position: Vector3): PrefabSpawnResult | null {
  const prefab = registry.get(key)
  if (!prefab)
    return null

  const result = prefab.spawn(position)
  return result === null ? null : (result ?? {})
}
