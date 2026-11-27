import type GameScene from '../../Scene/GameScene'
import type { SceneObjectData, SceneSide } from '../../Scene/types'
import type { GraphEntity } from '../NodeRegistry'
import type { GraphData, GraphValue } from '../types'
import { Object3D, Vector3 } from 'three'
import BaseGame from '../../BaseGame'
import { getSceneObject, registerSceneObject } from '../../Scene/SceneObjectRegistry'
import GameObject from '../../World/GameObject'
import { loadSubgraphs } from '../Nodes/subgraph'
import { graphUrl, isGraphName, parseGraphData } from '../types'
import { GraphRuntime } from './GraphRuntime'

/*
 * Logic graphs in a scene: a `LogicGraph` scene object loads a graph file and runs it, every tick, on the side(s)
 * its `side` prop names. Its `target` prop names the scene object the graph's Self is; without one it is itself.
 */

export const LOGIC_GRAPH_TYPE = 'LogicGraph'

export type LogicGraphSide = SceneSide | 'both'

export interface LogicGraphProps {
  /** The graph: `name` for graphs/<name>.graph.json, `<package>:<name>` for a plugin's */
  graph?: string
  /** Where it runs. Default `client` */
  side?: LogicGraphSide
  /** The id of the scene object the graph acts on as Self. Default this object */
  target?: string
  /** Values for the graph's parameters */
  parameters?: Record<string, GraphValue>
}

/** Where graphs come from: fetched from the dev server or the release on the client, read from disk on the server */
let source: (name: string) => Promise<GraphData> = async (name) => {
  const response = await fetch(graphUrl(name), { cache: 'no-store' })
  if (!response.ok)
    throw new Error(`Could not load graph ${name}: ${response.status} ${response.statusText}`)
  // Named as asked for: a plugin's file only has its own part of `<package>:<name>`
  return {
    ...parseGraphData(await response.json(), name),
    name,
  }
}

/** Load graphs from somewhere else. The server reads them from the project's graphs/ */
export function setGraphSource(load: (name: string) => Promise<GraphData>) {
  source = load
}

/** A graph file, from where this side gets graphs */
export function loadGraph(name: string): Promise<GraphData> {
  return source(name)
}

/** The logic graph objects on this side that run their graph here */
const live = new Set<LogicGraphObject>()

/** Send a message to every logic graph on this side, as a Send Message node does */
export function sendGraphMessage(name: string, value: GraphValue = 0) {
  for (const object of [...live])
    object.runtime?.message(name, value)
}

/** Told each step a graph runs: the node, and the logic graph object running it */
export type GraphStepListener = (node: string, object: string) => void
const stepListeners = new Map<string, Set<GraphStepListener>>()

/** Follow the steps the graph `name` runs, in every object running it here. Returns a function that stops */
export function watchLogicGraph(name: string, listener: GraphStepListener): () => void {
  const listeners = stepListeners.get(name) ?? new Set()
  listeners.add(listener)
  stepListeners.set(name, listeners)
  return () => {
    listeners.delete(listener)
    if (!listeners.size)
      stepListeners.delete(name)
  }
}

/**
 * Run a new version of the graph `name` in every object running it here, from the start (On Start runs again,
 * variables start over). Throws when it has problems, leaving the old version running. Returns how many it reached
 */
export function reloadLogicGraph(name: string, graph: GraphData): number {
  const objects = [...live].filter(object => object.props.graph === name)
  // Checked once before touching any, so a broken graph changes nothing
  if (objects.length)
    // eslint-disable-next-line no-new -- built only to check it
    new GraphRuntime(graph)
  for (const object of objects)
    object.useGraph(graph)
  return objects.length
}

/** Reads and moves an Object3D, or a GameObject's own vectors when it has none */
export function graphEntity(id: string, object: GameObject, target?: Object3D): GraphEntity {
  const position = target?.position ?? object.position
  const scale = target?.scale ?? object.scale
  return {
    id,
    getPosition: () => position.toArray(),
    setPosition: ([x = 0, y = 0, z = 0]) => {
      position.set(x, y, z)
    },
    getRotation: () => target
      ? [target.rotation.x, target.rotation.y, target.rotation.z]
      : object.rotation.toArray(),
    setRotation: ([x = 0, y = 0, z = 0]) => {
      if (target)
        target.rotation.set(x, y, z)
      else
        object.rotation.set(x, y, z)
    },
    getScale: () => scale.toArray(),
    setScale: ([x = 1, y = 1, z = 1]) => {
      scale.set(x, y, z)
    },
  }
}

/** A scene object as a graph entity: the Object3D the editor moves, as GameScene finds it */
function sceneEntity(scene: GameScene | undefined, id: string): GraphEntity | undefined {
  const entry = scene?.get(id)
  const object = entry?.object
  if (!entry || !object)
    return undefined
  const definition = getSceneObject(entry.data.type)
  const instance = (object as { instance?: unknown }).instance
  const target = definition?.transformTarget?.(object)
    ?? (instance instanceof Object3D
      ? instance
      : undefined)
  return graphEntity(id, object, target)
}

/** An entity found again on every use, so it follows the scene object when the editor rebuilds it */
function lazyEntity(id: string, find: () => GraphEntity | undefined): GraphEntity {
  const at = <T>(fn: (e: GraphEntity) => T, fallback: T) => {
    const entity = find()
    return entity
      ? fn(entity)
      : fallback
  }
  return {
    id,
    getPosition: () => at(e => e.getPosition(), [0, 0, 0]),
    setPosition: v => at(e => e.setPosition(v), undefined),
    getRotation: () => at(e => e.getRotation(), [0, 0, 0]),
    setRotation: v => at(e => e.setRotation(v), undefined),
    getScale: () => at(e => e.getScale(), [1, 1, 1]),
    setScale: v => at(e => e.setScale(v), undefined),
  }
}

export function runsOn(side: LogicGraphSide | undefined, here: SceneSide): boolean {
  return (side ?? 'client') === 'both' || (side ?? 'client') === here
}

/**
 * A logic graph running in a scene. It has a transform of its own, which is Self when no target is set
 */
export class LogicGraphObject extends GameObject {
  runtime?: GraphRuntime
  /** Why the graph isn't running, if it failed to load */
  error?: string
  readonly props: LogicGraphProps
  private readonly offKey?: () => void

  constructor(data: SceneObjectData, protected readonly scene: GameScene | undefined, readonly side: SceneSide) {
    super(data.id, new Vector3(...data.transform.position), new Vector3(...data.transform.rotation), new Vector3(...data.transform.scale))
    this.props = { ...(data.props as LogicGraphProps | undefined) }

    const name = this.props.graph
    if (name && isGraphName(name)) {
      live.add(this)
      void this.load(name)
    }

    if (side === 'client') {
      const input = (BaseGame.instance() as { input?: { on(e: string, cb: (ev: KeyboardEvent) => void): void, off(e: string, cb: (ev: KeyboardEvent) => void): void } }).input
      if (input) {
        const onKey = (ev: KeyboardEvent) => this.runtime?.trigger('keydown', { code: ev.code })
        input.on('keydown', onKey)
        this.offKey = () => input.off('keydown', onKey)
      }
    }
  }

  private async load(name: string) {
    try {
      const graph = await source(name)
      await loadSubgraphs(graph, source)
      if (!this.garbageCollect)
        this.useGraph(graph)
    }
    catch (err) {
      this.error = (err as Error).message
      BaseGame.instance().logger?.warn(`Logic graph ${this.id} (${name}) is not running: ${this.error}`)
    }
  }

  /** Run `graph`, from the start. Throws when it has problems */
  useGraph(graph: GraphData) {
    const name = this.props.graph ?? graph.name
    const logger = BaseGame.instance().logger
    const target = this.props.target
    const self = target
      ? lazyEntity(target, () => sceneEntity(this.scene, target))
      : graphEntity(this.id, this, undefined)
    this.runtime = new GraphRuntime(graph, {
      self,
      find: id => lazyEntity(id, () => sceneEntity(this.scene, id)),
      parameters: this.props.parameters,
      log: message => logger?.info(`[${name}] ${message}`),
      emit: sendGraphMessage,
      onStep: node => stepListeners.get(name)?.forEach(listener => listener(node, this.id)),
    })
    this.error = undefined
    this.runtime.start()
  }

  update(delta: number): void {
    this.runtime?.update(delta)
  }

  destroy(): void {
    live.delete(this)
    this.offKey?.()
    super.destroy()
  }
}

let registered = false

/** Make `LogicGraph` scene objects loadable on the server. The client registers its own, with an editor helper */
export function registerLogicGraphServerObject() {
  if (registered)
    return
  registered = true
  registerSceneObject<LogicGraphObject>({
    type: LOGIC_GRAPH_TYPE,
    label: 'Logic Graph',
    server: (data, { scene }) => runsOn((data.props as LogicGraphProps | undefined)?.side, 'server')
      ? new LogicGraphObject(data, scene, 'server')
      : undefined,
    serialize: object => ({ ...object.props }),
  })
}

/** How many objects run the graph `name` on this side */
export function logicGraphUsers(name: string): number {
  return [...live].filter(object => object.props.graph === name).length
}

/** For tests */
export function _resetLogicGraphs() {
  registered = false
  live.clear()
}
