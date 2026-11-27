import type { Material, Mesh } from 'three'
import type { GraphData } from '../types'
import type { CompiledMaterial } from './compileMaterialGraph'
import { Texture } from 'three'
import Game from '../../Game'
import { GRAPHS_LIST_PATH } from '../../Plugins/types'
import { graphUrl, parseGraphData } from '../types'
import { compileMaterialGraph } from './compileMaterialGraph'

export interface GraphListing {
  /** `lava`, or `@acme/water:ocean` for a plugin's */
  name: string
  kind: GraphData['kind']
  /** The plugin that ships it. Plugins' graphs can't be saved over, only copied into the project */
  plugin?: string
}

interface Entry {
  graph: GraphData
  compiled: CompiledMaterial
}

/**
 * The project's material graphs on the client: loaded from `graphs/<name>.graph.json`, compiled once and shared by
 * every mesh that uses them. Changing a graph (`set()`, as the editor does) swaps the new material onto those meshes.
 */
export class MaterialGraphLibrary {
  private entries = new Map<string, Entry>()
  private loading = new Map<string, Promise<Entry>>()
  private users = new Map<string, Set<Mesh>>()
  private listeners = new Set<() => void>()
  private listing: GraphListing[] = []

  /** The graphs the dev server knows of, after `refreshList()`. Empty in a release */
  get list(): GraphListing[] {
    return this.listing
  }

  /** Ask the dev server which graphs the project has */
  async refreshList(): Promise<GraphListing[]> {
    try {
      const response = await fetch(GRAPHS_LIST_PATH, { cache: 'no-store' })
      if (response.ok)
        this.listing = ((await response.json()) as { graphs: GraphListing[] }).graphs
    }
    catch {
      // Not the dev server
    }
    this.changed()
    return this.listing
  }

  /** Called when a graph is compiled again or the list changes */
  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private changed() {
    this.listeners.forEach(listener => listener())
  }

  /** A texture from the game's resources, by name */
  private texture(name: string): Texture | undefined {
    const item = Game.instance().resources.items[name] as unknown
    return item instanceof Texture
      ? item
      : undefined
  }

  private compile(graph: GraphData): CompiledMaterial {
    return compileMaterialGraph(graph, {
      textures: name => this.texture(name),
    })
  }

  /** The compiled graph, fetched and compiled on first use */
  async load(name: string): Promise<CompiledMaterial> {
    return (await this.entry(name)).compiled
  }

  /** The graph's data as last loaded or set */
  async graph(name: string): Promise<GraphData> {
    return (await this.entry(name)).graph
  }

  private entry(name: string): Promise<Entry> {
    const entry = this.entries.get(name)
    if (entry)
      return Promise.resolve(entry)

    let pending = this.loading.get(name)
    if (!pending) {
      pending = (async () => {
        const response = await fetch(graphUrl(name), { cache: 'no-store' })
        if (!response.ok)
          throw new Error(`Could not load graph ${name}: ${response.status} ${response.statusText}`)
        // Named as asked for: a plugin's file only has its own part of `<package>:<name>`
        const graph = {
          ...parseGraphData(await response.json(), name),
          name,
        }
        await Game.instance().resourcesReady()
        const loaded = {
          graph,
          compiled: this.compile(graph),
        }
        this.entries.set(name, loaded)
        return loaded
      })().finally(() => this.loading.delete(name))
      this.loading.set(name, pending)
    }
    return pending
  }

  /**
   * Compile `graph` as `name` and put it on every mesh using that graph. Throws when it doesn't compile, leaving the
   * meshes as they were.
   */
  set(name: string, graph: GraphData): CompiledMaterial {
    const compiled = this.compile(graph)
    const previous = this.entries.get(name)
    this.entries.set(name, { graph, compiled })
    for (const mesh of this.users.get(name) ?? [])
      mesh.material = compiled.material
    previous?.compiled.material.dispose()
    this.changed()
    return compiled
  }

  /**
   * Draw `mesh` with the graph's material, and keep it on the graph's latest version. Resolves to the material, or
   * rejects when the graph can't be loaded (the mesh keeps its material then).
   */
  async apply(mesh: Mesh, name: string): Promise<Material> {
    this.release(mesh)
    const users = this.users.get(name) ?? new Set()
    users.add(mesh)
    this.users.set(name, users)
    try {
      const { material } = await this.load(name)
      // Released or moved to another graph while loading
      if (this.users.get(name)?.has(mesh))
        mesh.material = material
      return material
    }
    catch (err) {
      users.delete(mesh)
      throw err
    }
  }

  /** Stop keeping `mesh` on a graph. Its material stays until changed */
  release(mesh: Mesh) {
    for (const users of this.users.values())
      users.delete(mesh)
  }

  /** The graph `mesh` uses, if any */
  graphOf(mesh: Mesh): string | undefined {
    for (const [name, users] of this.users) {
      if (users.has(mesh))
        return name
    }
    return undefined
  }
}

/** The game's material graphs */
export const materialGraphs = new MaterialGraphLibrary()
