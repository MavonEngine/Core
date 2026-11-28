import type { ScatterBrush } from '@mavonengine/core/Scatter/scatterBrush'
import { BRUSHES_PATH } from '@mavonengine/core/Plugins/types'
import { parseScatterBrush } from '@mavonengine/core/Scatter/scatterBrush'

/** A scatter brush as the dev server lists it: a plugin's is named `<package>:<name>` and is read only */
export type ListedScatterBrush = ScatterBrush & { plugin?: string }

/** The project's scatter brushes and those the enabled plugins ship. Empty outside the dev server */
export async function fetchScatterBrushes(): Promise<ListedScatterBrush[]> {
  try {
    const res = await fetch(BRUSHES_PATH, { cache: 'no-store' })
    if (!res.ok)
      return []
    const { brushes } = await res.json() as { brushes: unknown[] }
    return brushes.flatMap((raw) => {
      try {
        const brush = raw as { name?: string, plugin?: string }
        return [
          {
            ...parseScatterBrush(raw, brush.name),
            plugin: brush.plugin,
          },
        ]
      }
      catch {
        return []
      }
    })
  }
  catch {
    return []
  }
}

async function post(body: object): Promise<void> {
  const res = await fetch(BRUSHES_PATH, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) {
    const { error } = await res.json().catch(() => ({})) as { error?: string }
    throw new Error(error ?? `${res.status} ${res.statusText}`)
  }
}

/** Save to `brushes/<name>.brush.json` */
export function saveScatterBrush(brush: ScatterBrush): Promise<void> {
  return post({ name: brush.name, brush })
}

export function deleteScatterBrush(name: string): Promise<void> {
  return post({ name, delete: true })
}
