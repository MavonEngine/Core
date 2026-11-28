import type { AssetKind, ImportedAsset, PolyHavenAsset, Resolution } from './shared'
import { ASSET_KINDS, RESOLUTIONS } from './shared'

/*
 * The editor panel, in plain DOM: the editor bundles its own React, so a plugin renders into the element it is given.
 * Everything it loads comes from the plugin's dev entry (`base`), which keeps Poly Haven's answers and images.
 */

export interface PanelOptions {
  /** URL prefix of the dev entry, `devPluginBase(PACKAGE)` */
  base: string
  /** What the project has imported so far */
  imported(): ImportedAsset[]
  /** An import finished: load it into the running game */
  onImported(entry: ImportedAsset): Promise<void>
  /** Double-clicking a card opens a preview of it, once imported */
  preview?(entry: ImportedAsset): void
  /** Dropping a card on the viewport, when given */
  drop?: DropHandler<any>
  fetch?: typeof fetch
}

/**
 * What a card dropped on the viewport does. `target` runs right on the drop, so it sees what was under the cursor then;
 * `place` runs once the asset is imported and returns what to tell the user, throwing when it can't place it there
 */
export interface DropHandler<T> {
  canvas: HTMLElement
  target(clientX: number, clientY: number): T
  place(entry: ImportedAsset, target: T): string
}

/** The drag data of a card: `{ id, kind }` as JSON */
export const DRAG_MIME = 'application/x-mavonengine-polyhaven'

/** Cards rendered at once; "Show more" adds as many again */
const PAGE = 120

const KIND_LABELS: Record<AssetKind, string> = { textures: 'Textures', models: 'Models' }

const STYLE = `
.ph-root { display: flex; flex-direction: column; height: 100%; overflow: hidden; font-family: var(--font-ui); font-size: var(--font-size-sm, 11px); color: var(--text-primary, #e0e0e0); }
.ph-toolbar { display: flex; align-items: center; gap: 8px; padding: 6px 8px; flex-shrink: 0; flex-wrap: wrap; border-bottom: 1px solid var(--border-primary, #333); }
.ph-tabs { display: flex; gap: 2px; }
.ph-tab { background: none; border: 1px solid transparent; border-radius: 2px; color: var(--text-secondary, #888); padding: 2px 8px; cursor: pointer; font: inherit; }
.ph-tab[aria-pressed="true"] { color: var(--text-bright, #fff); background: var(--bg-active, #3a3a3a); border-color: var(--border-active, #555); }
.ph-input, .ph-select { height: 22px; background: var(--bg-input, #1e1e1e); border: 1px solid var(--border-primary, #333); border-radius: 2px; color: var(--text-primary, #e0e0e0); font: inherit; padding: 0 6px; }
.ph-input { flex: 1; min-width: 120px; }
.ph-check { display: flex; align-items: center; gap: 4px; cursor: pointer; user-select: none; }
.ph-count { color: var(--text-muted, #666); }
.ph-status { padding: 4px 8px; color: var(--text-secondary, #888); flex-shrink: 0; }
.ph-status[data-error] { color: var(--accent-red, #f44747); }
.ph-grid { flex: 1; overflow-y: auto; display: grid; grid-template-columns: repeat(auto-fill, minmax(112px, 1fr)); gap: 8px; padding: 8px; align-content: start; }
.ph-card { position: relative; display: flex; flex-direction: column; gap: 4px; background: var(--bg-secondary, #222); border: 1px solid var(--border-subtle, #2a2a2a); border-radius: 4px; padding: 4px; }
.ph-card:hover { border-color: var(--border-active, #555); }
.ph-thumb { width: 100%; aspect-ratio: 1; object-fit: cover; border-radius: 2px; background: var(--bg-input, #1e1e1e); }
.ph-name { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.ph-badge { position: absolute; top: 8px; left: 8px; background: var(--accent-green, #4ec9b0); color: #111; border-radius: 2px; padding: 0 4px; font-size: var(--font-size-xs, 10px); }
.ph-import { background: var(--accent-blue, #007acc); border: none; border-radius: 2px; color: #fff; font: inherit; padding: 3px 0; cursor: pointer; }
.ph-import:disabled { opacity: 0.6; cursor: default; }
.ph-more { grid-column: 1 / -1; justify-self: center; background: var(--bg-active, #3a3a3a); border: 1px solid var(--border-active, #555); border-radius: 2px; color: inherit; font: inherit; padding: 4px 12px; cursor: pointer; }
.ph-footer { padding: 4px 8px; color: var(--text-muted, #666); border-top: 1px solid var(--border-primary, #333); flex-shrink: 0; }
.ph-footer a { color: var(--text-secondary, #888); }
`

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, children: (Node | string)[] = []): HTMLElementTagNameMap[K] {
  const element = Object.assign(document.createElement(tag), props)
  element.append(...children)
  return element
}

/** Whether `asset` matches every word of `query` in its name, id, tags or categories */
export function matches(asset: PolyHavenAsset, query: string): boolean {
  const haystack = [
    asset.name,
    asset.id,
    ...asset.tags,
    ...asset.categories,
  ].join(' ').toLowerCase()
  return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => haystack.includes(word))
}

/** Render the panel into `container`. Returns its cleanup */
export function mountPanel(container: HTMLElement, options: PanelOptions): () => void {
  const fetchImpl = options.fetch ?? fetch
  const lists = new Map<AssetKind, PolyHavenAsset[]>()
  const importing = new Set<string>()
  let kind: AssetKind = 'textures'
  let shown = PAGE
  let disposed = false

  const style = el('style', { textContent: STYLE })
  const search = el('input', { className: 'ph-input', type: 'search', placeholder: 'Search name, tag or category' })
  const category = el('select', { className: 'ph-select', title: 'Category' })
  const resolution = el('select', { className: 'ph-select', title: 'Resolution to import' }, RESOLUTIONS.map(r => el('option', { value: r, textContent: r })))
  const count = el('span', { className: 'ph-count' })
  const onlyImported = el('input', { type: 'checkbox' })
  const onlyImportedLabel = el('label', { className: 'ph-check', title: 'Only what this project has imported' }, [onlyImported, 'Imported'])
  const tabs = ASSET_KINDS.map(k => el('button', { className: 'ph-tab', textContent: KIND_LABELS[k], type: 'button' }))
  const status = el('div', { className: 'ph-status' })
  const grid = el('div', { className: 'ph-grid' })
  const footer = el('div', { className: 'ph-footer' }, [
    'Assets from ',
    el('a', {
      href: 'https://polyhaven.com',
      target: '_blank',
      rel: 'noopener',
      textContent: 'Poly Haven',
    }),
    ', CC0. Powered by Poly Haven: thumbnails and files are cached in .mavonengine, imports go to public/polyhaven/',
  ])
  const root = el('div', { className: 'ph-root' }, [
    style,
    el('div', { className: 'ph-toolbar' }, [
      el('div', { className: 'ph-tabs' }, tabs),
      search,
      category,
      resolution,
      onlyImportedLabel,
      count,
    ]),
    status,
    grid,
    footer,
  ])
  container.append(root)

  const setStatus = (text: string, error = false) => {
    status.textContent = text
    status.hidden = !text
    status.toggleAttribute('data-error', error)
  }

  async function api<T>(path: string, init?: RequestInit): Promise<T> {
    const res = await fetchImpl(`${options.base}${path}`, init)
    const body = await res.json().catch(() => ({})) as T & { error?: string }
    if (!res.ok)
      throw new Error(body.error ?? `The dev server answered ${res.status}`)
    return body
  }

  function filtered(): PolyHavenAsset[] {
    const list = lists.get(kind) ?? []
    const imported = onlyImported.checked
      ? new Set(options.imported().filter(entry => entry.kind === kind).map(entry => entry.id))
      : undefined
    return list.filter(asset => (!imported || imported.has(asset.id)) && (!category.value || asset.categories.includes(category.value)) && matches(asset, search.value))
  }

  function fillCategories() {
    const counts = new Map<string, number>()
    for (const asset of lists.get(kind) ?? []) {
      for (const c of asset.categories)
        counts.set(c, (counts.get(c) ?? 0) + 1)
    }
    const current = category.value
    category.replaceChildren(
      el('option', { value: '', textContent: 'All categories' }),
      ...[...counts].sort(([a], [b]) => a.localeCompare(b)).map(([c, n]) => el('option', { value: c, textContent: `${c} (${n})` })),
    )
    category.value = counts.has(current)
      ? current
      : ''
  }

  function card(asset: PolyHavenAsset): HTMLElement {
    const assetKind = kind
    const imported = options.imported().find(entry => entry.id === asset.id)
    const button = el('button', {
      className: 'ph-import',
      type: 'button',
      disabled: importing.has(asset.id),
      textContent: importing.has(asset.id)
        ? 'Importing…'
        : imported
          ? `Reimport ${resolution.value}`
          : `Import ${resolution.value}`,
      title: kind === 'textures'
        ? 'Download the maps into the project and make a material graph for them'
        : 'Download the glTF into the project',
    })
    button.addEventListener('click', () => void importAsset(asset, assetKind))
    const hint = options.drop
      ? assetKind === 'models'
        ? '\nDrag into the viewport to place it. Double-click to preview'
        : '\nDrag onto a primitive in the viewport to give it this material. Double-click to preview'
      : ''
    const element = el('div', {
      className: 'ph-card',
      title: `${asset.name}\n${asset.categories.join(', ')}\nby ${asset.authors.join(', ')}${hint}`,
      draggable: !!options.drop,
    }, [
      el('img', {
        className: 'ph-thumb',
        loading: 'lazy',
        alt: asset.name,
        src: `${options.base}thumbs/${asset.id}.png`,
      }),
      ...(imported
        ? [
            el('span', { className: 'ph-badge', textContent: `Imported ${imported.resolution}` }),
          ]
        : []),
      el('span', { className: 'ph-name', textContent: asset.name }),
      button,
    ])
    if (options.preview) {
      element.addEventListener('dblclick', (e) => {
        if ((e.target as HTMLElement).closest('button'))
          return
        void openPreview(asset, assetKind)
      })
    }
    element.addEventListener('dragstart', (e) => {
      if (!e.dataTransfer)
        return
      e.dataTransfer.setData(DRAG_MIME, JSON.stringify({ id: asset.id, kind: assetKind }))
      e.dataTransfer.effectAllowed = 'copy'
    })
    return element
  }

  function render() {
    tabs.forEach((tab, i) => tab.setAttribute('aria-pressed', String(ASSET_KINDS[i] === kind)))
    const list = filtered()
    count.textContent = lists.has(kind)
      ? `${list.length} ${KIND_LABELS[kind].toLowerCase()}`
      : ''
    const cards = list.slice(0, shown).map(card)
    if (list.length > shown) {
      const more = el('button', { className: 'ph-more', type: 'button', textContent: `Show more (${list.length - shown} left)` })
      more.addEventListener('click', () => {
        shown += PAGE
        render()
      })
      cards.push(more)
    }
    grid.replaceChildren(...cards)
  }

  async function load(k: AssetKind) {
    if (lists.has(k))
      return
    setStatus(`Loading Poly Haven's ${KIND_LABELS[k].toLowerCase()}…`)
    try {
      const { assets } = await api<{ assets: PolyHavenAsset[] }>(`assets/${k}`)
      lists.set(k, assets)
      setStatus('')
    }
    catch (err) {
      setStatus(`Could not load the ${KIND_LABELS[k].toLowerCase()}: ${(err as Error).message}`, true)
    }
    if (!disposed && k === kind) {
      fillCategories()
      render()
    }
  }

  /** Import `asset`, and load it into the game. Undefined when it failed, which the status says */
  async function importAsset(asset: PolyHavenAsset, assetKind: AssetKind): Promise<ImportedAsset | undefined> {
    const wanted = resolution.value as Resolution
    importing.add(asset.id)
    render()
    setStatus(`Importing ${asset.name} at ${wanted}…`)
    try {
      const { imported } = await api<{ imported: ImportedAsset & { graphCreated?: boolean } }>('import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: asset.id, kind: assetKind, resolution: wanted }),
      })
      await options.onImported(imported)
      const where = imported.kind === 'models'
        ? `as the model ${imported.files.gltf}`
        : imported.graphCreated
          ? `with the material graph ${imported.graph}`
          : `keeping your material graph ${imported.graph}`
      setStatus(`Imported ${asset.name} at ${imported.resolution} ${where}`)
      return imported
    }
    catch (err) {
      setStatus(`Could not import ${asset.name}: ${(err as Error).message}`, true)
      return undefined
    }
    finally {
      importing.delete(asset.id)
      if (!disposed)
        render()
    }
  }

  tabs.forEach((tab, i) => tab.addEventListener('click', () => {
    kind = ASSET_KINDS[i]!
    shown = PAGE
    fillCategories()
    render()
    void load(kind)
  }))
  search.addEventListener('input', () => {
    shown = PAGE
    render()
  })
  category.addEventListener('change', () => {
    shown = PAGE
    render()
  })
  resolution.addEventListener('change', render)
  onlyImported.addEventListener('change', () => {
    shown = PAGE
    render()
  })

  /** Preview an asset, importing it first when the project doesn't have it */
  async function openPreview(asset: PolyHavenAsset, assetKind: AssetKind) {
    if (importing.has(asset.id))
      return
    const entry = options.imported().find(existing => existing.id === asset.id && existing.kind === assetKind)
      ?? await importAsset(asset, assetKind)
    if (entry && !disposed)
      options.preview?.(entry)
  }

  /** The card's data, when what is dragged is one */
  function dragged(e: DragEvent): { id: string, kind: AssetKind } | undefined {
    if (!e.dataTransfer?.types.includes(DRAG_MIME))
      return undefined
    try {
      const data = JSON.parse(e.dataTransfer.getData(DRAG_MIME)) as { id?: unknown, kind?: unknown }
      if (typeof data.id === 'string' && ASSET_KINDS.includes(data.kind as AssetKind))
        return { id: data.id, kind: data.kind as AssetKind }
    }
    catch {}
    return undefined
  }

  function onDragOver(e: DragEvent) {
    // The data itself can't be read until the drop
    if (!e.dataTransfer?.types.includes(DRAG_MIME))
      return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
  }

  async function onDrop(e: DragEvent) {
    const drop = options.drop
    const card = dragged(e)
    if (!drop || !card)
      return
    e.preventDefault()
    const target = drop.target(e.clientX, e.clientY)
    const asset = lists.get(card.kind)?.find(a => a.id === card.id)
    if (!asset || importing.has(asset.id))
      return

    // Already imported: placed as it is, at the resolution it has
    const entry = options.imported().find(existing => existing.id === asset.id && existing.kind === card.kind)
      ?? await importAsset(asset, card.kind)
    if (!entry || disposed)
      return
    try {
      setStatus(drop.place(entry, target))
    }
    catch (err) {
      setStatus((err as Error).message, true)
    }
  }

  const dropListener = (e: DragEvent) => void onDrop(e)
  options.drop?.canvas.addEventListener('dragover', onDragOver)
  options.drop?.canvas.addEventListener('drop', dropListener)

  setStatus('')
  render()
  void load(kind)

  return () => {
    disposed = true
    options.drop?.canvas.removeEventListener('dragover', onDragOver)
    options.drop?.canvas.removeEventListener('drop', dropListener)
    root.remove()
  }
}
