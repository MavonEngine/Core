// @vitest-environment jsdom
import type { ImportedAsset, PolyHavenAsset } from '../src/shared'
import { describe, expect, it, vi } from 'vitest'
import { DRAG_MIME, mountPanel } from '../src/panel'

function asset(id: string, categories: string[]): PolyHavenAsset {
  return {
    id,
    name: id.replace(/_/g, ' '),
    categories,
    tags: [],
    authors: [],
    downloads: 0,
    published: 0,
  }
}

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

describe('the panel', () => {
  it('lists, filters and imports through the dev entry', async () => {
    const imported: ImportedAsset[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/base/assets/textures') {
        return Response.json({
          assets: [
            asset('rock_wall', ['rock']),
            asset('red_brick', ['brick']),
          ],
        })
      }
      if (url === '/base/import') {
        const { id, kind, resolution } = JSON.parse(String(init?.body))
        return Response.json({
          imported: {
            id,
            kind,
            resolution,
            name: id,
            files: {},
            graph: `polyhaven_${id}`,
            graphCreated: true,
          },
        })
      }
      return Response.json({ error: 'nope' }, { status: 404 })
    })
    const onImported = vi.fn(async (entry: ImportedAsset) => {
      imported.push(entry)
    })
    const container = document.createElement('div')
    const cleanup = mountPanel(container, {
      base: '/base/',
      imported: () => imported,
      onImported,
      fetch: fetchMock as typeof fetch,
    })
    await flush()

    const names = () => [
      ...container.querySelectorAll('.ph-name'),
    ].map(el => el.textContent)
    expect(names()).toEqual(['rock wall', 'red brick'])
    expect(container.querySelector('img')?.getAttribute('src')).toBe('/base/thumbs/rock_wall.png')
    expect(container.textContent).toContain('Powered by Poly Haven')

    const search = container.querySelector<HTMLInputElement>('.ph-input')!
    search.value = 'brick'
    search.dispatchEvent(new Event('input'))
    expect(names()).toEqual(['red brick'])

    container.querySelector<HTMLButtonElement>('.ph-import')!.click()
    await flush()
    await flush()
    expect(JSON.parse(String(fetchMock.mock.calls.find(([url]) => url === '/base/import')![1]!.body))).toEqual({ id: 'red_brick', kind: 'textures', resolution: '1k' })
    expect(onImported).toHaveBeenCalledOnce()
    expect(container.querySelector('.ph-badge')?.textContent).toBe('Imported 1k')
    expect(container.querySelector('.ph-status')?.textContent).toContain('polyhaven_red_brick')

    cleanup()
    expect(container.children.length).toBe(0)
  })
})

/** jsdom has no DragEvent: an event carrying a DataTransfer-like object */
function dragEvent(type: string, data: Record<string, string>, at = { clientX: 10, clientY: 20 }) {
  const event = new Event(type, { bubbles: true, cancelable: true })
  Object.assign(event, {
    ...at,
    dataTransfer: {
      types: Object.keys(data),
      getData: (key: string) => data[key] ?? '',
      setData: (key: string, value: string) => {
        data[key] = value
      },
      effectAllowed: 'none',
      dropEffect: 'none',
    },
  })
  return event
}

describe('dropping a card on the viewport', () => {
  it('imports it when needed, with the target from when it was dropped', async () => {
    const imported: ImportedAsset[] = []
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/base/assets/textures') {
        return Response.json({
          assets: [
            asset('rock_wall', ['rock']),
          ],
        })
      }
      const { id, kind, resolution } = JSON.parse(String(init?.body))
      return Response.json({
        imported: {
          id,
          kind,
          resolution,
          name: id,
          files: {},
          graph: `polyhaven_${id}`,
          graphCreated: true,
        },
      })
    })
    const canvas = document.createElement('canvas')
    const target = vi.fn((x: number, y: number) => ({ x, y }))
    const place = vi.fn((entry: ImportedAsset) => `placed ${entry.id}`)
    const container = document.createElement('div')
    const cleanup = mountPanel(container, {
      base: '/base/',
      imported: () => imported,
      onImported: async (entry) => {
        imported.push(entry)
      },
      drop: { canvas, target, place },
      fetch: fetchMock as typeof fetch,
    })
    await flush()

    // Dragging a card carries its id and kind
    const data: Record<string, string> = {}
    container.querySelector('.ph-card')!.dispatchEvent(dragEvent('dragstart', data))
    expect(JSON.parse(data[DRAG_MIME]!)).toEqual({ id: 'rock_wall', kind: 'textures' })

    const over = dragEvent('dragover', data)
    canvas.dispatchEvent(over)
    expect(over.defaultPrevented).toBe(true)

    canvas.dispatchEvent(dragEvent('drop', data))
    await flush()
    await flush()
    expect(target).toHaveBeenCalledWith(10, 20)
    expect(fetchMock.mock.calls.filter(([url]) => url === '/base/import')).toHaveLength(1)
    expect(place).toHaveBeenCalledWith(expect.objectContaining({ id: 'rock_wall' }), { x: 10, y: 20 })
    expect(container.querySelector('.ph-status')?.textContent).toBe('placed rock_wall')

    // Imported already: placed without importing again
    canvas.dispatchEvent(dragEvent('drop', data))
    await flush()
    expect(fetchMock.mock.calls.filter(([url]) => url === '/base/import')).toHaveLength(1)
    expect(place).toHaveBeenCalledTimes(2)

    // Other drags are left to the editor
    const other = dragEvent('dragover', { 'application/mavonengine-resource': 'tree' })
    canvas.dispatchEvent(other)
    expect(other.defaultPrevented).toBe(false)

    cleanup()
    canvas.dispatchEvent(dragEvent('drop', data))
    await flush()
    expect(place).toHaveBeenCalledTimes(2)
  })
})

describe('the Imported filter and previews', () => {
  it('shows only imports when checked, and double-click previews, importing first', async () => {
    const imported: ImportedAsset[] = [
      {
        id: 'rock_wall',
        kind: 'textures',
        name: 'Rock Wall',
        resolution: '2k',
        files: {},
        graph: 'polyhaven_rock_wall',
      },
    ]
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
      if (url === '/base/assets/textures') {
        return Response.json({
          assets: [
            asset('rock_wall', ['rock']),
            asset('red_brick', ['brick']),
          ],
        })
      }
      const { id, kind, resolution } = JSON.parse(String(init?.body))
      return Response.json({
        imported: {
          id,
          kind,
          resolution,
          name: id,
          files: {},
          graph: `polyhaven_${id}`,
        },
      })
    })
    const preview = vi.fn()
    const container = document.createElement('div')
    const cleanup = mountPanel(container, {
      base: '/base/',
      imported: () => imported,
      onImported: async (entry) => {
        imported.push(entry)
      },
      preview,
      fetch: fetchMock as typeof fetch,
    })
    await flush()
    const names = () => [
      ...container.querySelectorAll('.ph-name'),
    ].map(el => el.textContent)

    const checkbox = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!
    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change'))
    expect(names()).toEqual(['rock wall'])

    // Imported: previewed as it is
    container.querySelector('.ph-card')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flush()
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'rock_wall', resolution: '2k' }))
    expect(fetchMock.mock.calls.some(([url]) => url === '/base/import')).toBe(false)

    // Not imported: imported, then previewed
    checkbox.checked = false
    checkbox.dispatchEvent(new Event('change'))
    container.querySelectorAll('.ph-card')[1]!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))
    await flush()
    await flush()
    expect(fetchMock.mock.calls.filter(([url]) => url === '/base/import')).toHaveLength(1)
    expect(preview).toHaveBeenLastCalledWith(expect.objectContaining({ id: 'red_brick' }))

    checkbox.checked = true
    checkbox.dispatchEvent(new Event('change'))
    expect(names()).toEqual(['rock wall', 'red brick'])
    cleanup()
  })
})
