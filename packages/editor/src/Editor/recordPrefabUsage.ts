import Game from '@mavonengine/core/Game'
import { PREFAB_USED_PATH } from '@mavonengine/core/Plugins/types'

const recorded = new Set<string>()

/**
 * Tell the dev server that the project uses a plugin prefab, so its assets ship in the release.
 * The server adds it to the plugin's `prefabs` in mavonengine.json. Sent once per prefab per session.
 */
export function recordPrefabUsage(plugin: string, prefab: string, fetchFn: typeof fetch = fetch): Promise<void> {
  const key = `${plugin}:${prefab}`
  if (recorded.has(key))
    return Promise.resolve()
  recorded.add(key)

  const warn = (reason: string) => {
    recorded.delete(key)
    Game.instance().logger?.warn(`Could not record that ${plugin} prefab ${prefab} is used, add it to "prefabs" in mavonengine.json yourself: ${reason}`)
  }

  return fetchFn(PREFAB_USED_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ plugin, prefab }),
  }).then(
    res => (res.ok ? undefined : warn(`${res.status} ${res.statusText}`)),
    (err: Error) => warn(err.message),
  )
}

/** For tests */
export function resetRecordedPrefabs() {
  recorded.clear()
}
