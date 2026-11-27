import type { GraphData, GraphKind, GraphParameter, GraphValue, PinType } from '@mavonengine/core/Graph/types'
import type { GraphIssue } from '@mavonengine/core/Graph/validate'
import type { Connection, NodeTypes } from '@xyflow/react'
import type { Material } from 'three'
import type { FlowEdge, FlowNode } from './graphModel'
import type { GraphEditorContext } from './GraphNode'
import Game from '@mavonengine/core/Game'
import { GraphRuntime, GraphRuntimeError } from '@mavonengine/core/Graph/Logic/GraphRuntime'
import { loadGraph, LOGIC_GRAPH_TYPE, reloadLogicGraph, watchLogicGraph } from '@mavonengine/core/Graph/Logic/logicGraphObject'
import { MaterialGraphError } from '@mavonengine/core/Graph/Material/compileMaterialGraph'
import { materialGraphs } from '@mavonengine/core/Graph/Material/MaterialGraphs'
import { canConnect, getNode, getNodes } from '@mavonengine/core/Graph/NodeRegistry'
import { registerBuiltinNodes } from '@mavonengine/core/Graph/Nodes/builtin'
import { GRAPH_NAME_RE } from '@mavonengine/core/Graph/types'
import { analyzeGraph } from '@mavonengine/core/Graph/validate'
import { GRAPH_SAVE_PATH } from '@mavonengine/core/Plugins/types'
import { Background, Controls, ReactFlow, ReactFlowProvider, useEdgesState, useNodesState, useReactFlow } from '@xyflow/react'
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react'
import { Texture } from 'three'
import { defaultLogicGraph, defaultMaterialGraph, defaultValue, edgeId, fromFlow, graphKey, newNodeId, PIN_COLORS, toFlow } from './graphModel'
import GraphNode, { GraphContext } from './GraphNode'
import styles from './Graphs.module.css'
import MaterialPreview from './MaterialPreview'
import '@xyflow/react/dist/style.css'

const nodeTypes: NodeTypes = { graph: GraphNode }

const PARAMETER_TYPES: PinType[] = [
  'float',
  'vec2',
  'vec3',
  'vec4',
  'color',
]

function textureNames(): string[] {
  const items = Game.instance().resources.items as Record<string, unknown>
  return Object.entries(items).filter(([, item]) => item instanceof Texture).map(([name]) => name).sort()
}

const isTyping = (target: EventTarget | null) => target instanceof HTMLElement && /^(?:INPUT|SELECT|TEXTAREA)$/.test(target.tagName)

async function saveGraph(name: string, graph: GraphData): Promise<string | undefined> {
  try {
    const response = await fetch(GRAPH_SAVE_PATH, {
      method: 'POST',
      body: JSON.stringify({ name, graph }),
    })
    if (!response.ok)
      return ((await response.json()) as { error?: string }).error ?? `${response.status} ${response.statusText}`
    return undefined
  }
  catch (err) {
    return (err as Error).message
  }
}

/** The active scene's objects, to pick entities from */
function sceneEntities(): { value: string, label: string }[] {
  return (Game.instance().activeScene?.getEntries() ?? [])
    .map(entry => ({
      value: entry.data.id,
      label: entry.data.name
        ? `${entry.data.name} (${entry.data.id})`
        : entry.data.id,
    }))
}

/** How long a node stays lit after it ran */
const ACTIVE_MS = 300

/** The nodes of the logic graph `name` that ran in the last moment, in any object running it here */
function useActiveNodes(name: string | undefined): Set<string> {
  const [active, setActive] = useState<Set<string>>(() => new Set())
  useEffect(() => {
    if (!name)
      return
    const lastRun = new Map<string, number>()
    const stop = watchLogicGraph(name, node => lastRun.set(node, performance.now()))
    // Checked a few times a second rather than on every step: a tick runs many
    const timer = setInterval(() => {
      const now = performance.now()
      const next = new Set([...lastRun].filter(([, at]) => now - at < ACTIVE_MS).map(([node]) => node))
      setActive(previous => previous.size === next.size && [...next].every(node => previous.has(node))
        ? previous
        : next)
    }, 100)
    return () => {
      stop()
      clearInterval(timer)
    }
  }, [name])
  return active
}

/** Picks a node type to add, at where the canvas was right clicked */
function NodePalette({ kind, at, onPick, onClose }: { kind: GraphKind, at: { x: number, y: number }, onPick(type: string): void, onClose(): void }) {
  const [filter, setFilter] = useState('')
  const nodes = getNodes(kind).filter(node => `${node.category} ${node.label} ${node.type}`.toLowerCase().includes(filter.toLowerCase()))
  const categories = [
    ...new Set(nodes.map(node => node.category)),
  ]

  return (
    <div className={styles.palette} style={{ left: at.x, top: at.y }} onPointerDown={e => e.stopPropagation()}>
      <input
        autoFocus
        className={styles.paletteSearch}
        placeholder="Add node…"
        value={filter}
        onChange={e => setFilter(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Escape')
            onClose()
          if (e.key === 'Enter' && nodes[0])
            onPick(nodes[0].type)
        }}
      />
      <div className={styles.paletteList}>
        {categories.map(category => (
          <div key={category}>
            <div className={styles.paletteCategory}>{category}</div>
            {nodes.filter(node => node.category === category).map(node => (
              <button key={node.type} className={styles.paletteItem} title={node.description} onClick={() => onPick(node.type)}>
                {node.label}
              </button>
            ))}
          </div>
        ))}
        {!nodes.length && <div className={styles.muted}>No node matches</div>}
      </div>
    </div>
  )
}

function ParameterList({ parameters, onChange }: { parameters: GraphParameter[], onChange(parameters: GraphParameter[]): void }) {
  const [name, setName] = useState('')
  const taken = parameters.some(p => p.name === name)

  return (
    <div className={styles.section}>
      <div className={styles.sectionTitle}>Parameters</div>
      {parameters.map((parameter, index) => (
        <div key={parameter.name} className={styles.parameter}>
          <span className={styles.parameterName}>{parameter.name}</span>
          <select
            value={parameter.type}
            onChange={(e) => {
              const type = e.target.value as PinType
              onChange(parameters.map((p, i) => i === index
                ? {
                    ...p,
                    type,
                    default: defaultValue(type),
                  }
                : p))
            }}
          >
            {PARAMETER_TYPES.map(type => <option key={type} value={type}>{type}</option>)}
          </select>
          <button className={styles.iconButton} title="Remove" onClick={() => onChange(parameters.filter((_, i) => i !== index))}>×</button>
        </div>
      ))}
      <div className={styles.parameter}>
        <input
          className={styles.text}
          placeholder="name"
          value={name}
          onChange={e => setName(e.target.value.replace(/\W/g, ''))}
        />
        <button
          disabled={!name || taken}
          onClick={() => {
            onChange([
              ...parameters,
              { name, type: 'float', default: 0 },
            ])
            setName('')
          }}
        >
          Add
        </button>
      </div>
    </div>
  )
}

/** The graph being edited: React Flow holds its nodes and edges, every change compiles it onto the scene */
function GraphEditor({ initial, onSaved }: { initial: GraphData, onSaved(): void }) {
  const flow = useMemo(() => toFlow(initial), [initial])
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(flow.nodes)
  const [edges, setEdges, onEdgesChange] = useEdgesState<FlowEdge>(flow.edges)
  const [parameters, setParameters] = useState(initial.parameters)
  const [palette, setPalette] = useState<{ screen: { x: number, y: number }, flow: { x: number, y: number } }>()
  // Made the same way as `graph` below, so an untouched graph compares equal
  const [saved, setSaved] = useState(() => JSON.stringify(fromFlow(initial, flow.nodes, flow.edges, initial.parameters)))
  const [compiled, setCompiled] = useState<{ material?: Material, issues: GraphIssue[], running?: number }>({ issues: [] })
  const active = useActiveNodes(initial.kind === 'logic'
    ? initial.name
    : undefined)
  const [status, setStatus] = useState<string>()
  const { screenToFlowPosition } = useReactFlow()
  const wrapper = useRef<HTMLDivElement>(null)

  const graph = useMemo(() => fromFlow(initial, nodes, edges, parameters), [initial, nodes, edges, parameters])
  const key = graphKey(graph)
  const dirty = JSON.stringify(graph) !== saved

  // Only what changes the material compiles it again, not moving nodes around
  const analysis = useMemo(() => analyzeGraph(graph), [key])
  useEffect(() => {
    try {
      if (graph.kind === 'logic') {
        // eslint-disable-next-line no-new -- built to check it, also when nothing runs it
        new GraphRuntime(graph)
        // Also runs it, from the start, in the scene's logic graph objects using it
        setCompiled({
          issues: [],
          running: reloadLogicGraph(graph.name, graph),
        })
      }
      else {
        // Also puts it on the scene's meshes that use this graph
        setCompiled({ material: materialGraphs.set(graph.name, graph).material, issues: [] })
      }
    }
    catch (err) {
      setCompiled(previous => ({
        // The last material that compiled stays on the preview
        ...previous,
        issues: err instanceof MaterialGraphError || err instanceof GraphRuntimeError
          ? err.issues
          : [
              { message: (err as Error).message },
            ],
      }))
    }
  }, [key])
  const { material, issues, running } = compiled

  // Exec edges white and thick, value edges in their type's color
  const styledEdges = useMemo(() => edges.map((edge) => {
    const type = analysis.outputTypes.get(edge.source)?.[edge.sourceHandle ?? '']
      ?? (getNode(nodes.find(node => node.id === edge.source)?.data.type ?? '')?.outputs[edge.sourceHandle ?? '']?.type === 'exec'
        ? 'exec'
        : undefined)
    return {
      ...edge,
      style: {
        stroke: PIN_COLORS[type ?? 'number'],
        strokeWidth: type === 'exec'
          ? 3
          : 2,
      },
      animated: type === 'exec' && (active.has(edge.source) || active.has(edge.target)),
    }
  }), [edges, analysis, nodes, active])

  const place = () => {
    const scene = Game.instance().activeScene
    if (!scene) {
      setStatus('No scene to place it in')
      return
    }
    const entry = scene.create(LOGIC_GRAPH_TYPE, {
      transform: {
        position: [0, 0, 0],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      },
      props: { graph: graph.name },
    })
    setStatus(entry
      ? `Placed as ${entry.data.id}: pick what it acts on in its properties`
      : 'Could not place it')
  }

  const setValue = useCallback((id: string, port: string, value: GraphValue) => {
    setNodes(all => all.map(node => node.id === id
      ? {
          ...node,
          data: {
            ...node.data,
            values: { ...node.data.values, [port]: value },
          },
        }
      : node))
  }, [setNodes])

  const context = useMemo<GraphEditorContext>(() => ({
    analysis,
    parameters,
    textures: textureNames(),
    entities: sceneEntities(),
    active,
    setValue,
  }), [analysis, parameters, setValue, active])

  const onConnect = useCallback((connection: Connection) => {
    const edge = {
      from: { node: connection.source, port: connection.sourceHandle ?? '' },
      to: { node: connection.target, port: connection.targetHandle ?? '' },
    }
    // An input takes one edge: a new one replaces it
    setEdges(all => [
      ...all.filter(e => !(e.target === edge.to.node && e.targetHandle === edge.to.port)),
      {
        id: edgeId(edge),
        source: edge.from.node,
        sourceHandle: edge.from.port,
        target: edge.to.node,
        targetHandle: edge.to.port,
      },
    ])
  }, [setEdges])

  const isValidConnection = useCallback((connection: Connection | FlowEdge) => {
    if (connection.source === connection.target)
      return false
    const target = nodes.find(node => node.id === connection.target)
    const spec = target && getNode(target.data.type)?.inputs[connection.targetHandle ?? '']
    const from = analysis.outputTypes.get(connection.source)?.[connection.sourceHandle ?? '']
    return !!spec && (!from || canConnect(from, spec.type))
  }, [nodes, analysis])

  const addNode = (type: string) => {
    if (!palette)
      return
    const id = newNodeId(type, nodes.map(node => node.id))
    setNodes(all => [
      ...all,
      {
        id,
        type: 'graph',
        position: palette.flow,
        data: { type, values: {} },
      },
    ])
    setPalette(undefined)
  }

  const save = async () => {
    setStatus('Saving…')
    const error = await saveGraph(graph.name, graph)
    if (error) {
      setStatus(`Not saved: ${error}`)
      return
    }
    setSaved(JSON.stringify(graph))
    setStatus('Saved')
    onSaved()
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    // The scene editor listens on the window: Delete would delete its selected object, Ctrl+S save the scene
    e.stopPropagation()
    if ((e.ctrlKey || e.metaKey) && e.code === 'KeyS') {
      e.preventDefault()
      void save()
      return
    }
    if (isTyping(e.target))
      return
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const removed = new Set(nodes.filter(node => node.selected).map(node => node.id))
      setNodes(all => all.filter(node => !removed.has(node.id)))
      setEdges(all => all.filter(edge => !edge.selected && !removed.has(edge.source) && !removed.has(edge.target)))
    }
  }

  return (
    <GraphContext.Provider value={context}>
      <div
        className={styles.editor}
        tabIndex={-1}
        ref={wrapper}
        onKeyDown={onKeyDown}
        onPointerDown={(e) => {
          if (!isTyping(e.target))
            wrapper.current?.focus()
        }}
      >
        <div className={styles.canvas}>
          <ReactFlow
            nodes={nodes}
            edges={styledEdges}
            nodeTypes={nodeTypes}
            onNodesChange={onNodesChange}
            onEdgesChange={onEdgesChange}
            onConnect={onConnect}
            isValidConnection={isValidConnection}
            deleteKeyCode={null}
            colorMode="dark"
            fitView
            fitViewOptions={{ maxZoom: 1 }}
            onPaneClick={() => setPalette(undefined)}
            onPaneContextMenu={(e) => {
              e.preventDefault()
              const bounds = wrapper.current!.getBoundingClientRect()
              setPalette({
                screen: { x: e.clientX - bounds.left, y: e.clientY - bounds.top },
                flow: screenToFlowPosition({ x: e.clientX, y: e.clientY }),
              })
            }}
            defaultEdgeOptions={{
              style: { stroke: PIN_COLORS.number, strokeWidth: 2 },
            }}
          >
            <Background gap={20} />
            <Controls showInteractive={false} />
          </ReactFlow>
          {palette && <NodePalette kind={graph.kind} at={palette.screen} onPick={addNode} onClose={() => setPalette(undefined)} />}
          <div className={styles.hint}>Right click to add a node · Delete removes the selection</div>
        </div>

        <div className={styles.side}>
          {graph.kind === 'material' && <MaterialPreview material={material} />}
          <div className={styles.section}>
            <div className={styles.toolbar}>
              <strong>{graph.name}</strong>
              <button disabled={!dirty} onClick={() => void save()}>{dirty ? 'Save' : 'Saved'}</button>
            </div>
            {status && <div className={styles.muted}>{status}</div>}
          </div>
          {graph.kind === 'logic' && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>In the scene</div>
              <div className={styles.muted}>
                {running
                  ? `Running in ${running} object${running === 1
                    ? ''
                    : 's'} here, restarted on every change. Steps light up as they run`
                  : 'Not running here. Place it in the scene, or set a Logic Graph object to it'}
              </div>
              <button onClick={place}>Place in scene</button>
            </div>
          )}
          <ParameterList parameters={parameters} onChange={setParameters} />
          {issues.length > 0 && (
            <div className={styles.section}>
              <div className={styles.sectionTitle}>Problems</div>
              {issues.map(issue => (
                <div key={`${issue.node}${issue.message}`} className={styles.issue}>
                  {issue.node && (
                    <strong>
                      {issue.node}
                      :
                      {' '}
                    </strong>
                  )}
                  {issue.message}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </GraphContext.Provider>
  )
}

const KINDS: { kind: GraphKind, title: string, empty: string }[] = [
  { kind: 'material', title: 'Material graphs', empty: 'No material graphs yet' },
  { kind: 'logic', title: 'Logic graphs', empty: 'No logic graphs yet' },
]

/**
 * The project's graphs: pick or create one on the left, edit it in the node canvas. A material graph shows on the
 * preview sphere and on every mesh using it as it changes, a logic graph restarts in every object running it, with
 * its steps lit up as they run.
 */
export default function GraphsView() {
  registerBuiltinNodes()
  const list = useSyncExternalStore(useCallback(listener => materialGraphs.subscribe(listener), []), () => materialGraphs.list)
  const [selected, setSelected] = useState<{ name: string, kind: GraphKind }>()
  const [loaded, setLoaded] = useState<GraphData>()
  const [error, setError] = useState<string>()
  const [newName, setNewName] = useState('')
  const [newKind, setNewKind] = useState<GraphKind>('material')

  useEffect(() => {
    void materialGraphs.refreshList()
  }, [])

  useEffect(() => {
    setLoaded(undefined)
    setError(undefined)
    if (!selected)
      return
    let live = true
    const load = selected.kind === 'material'
      ? materialGraphs.graph(selected.name)
      : loadGraph(selected.name)
    load.then(
      graph => live && setLoaded(graph),
      (err: Error) => live && setError(err.message),
    )
    return () => {
      live = false
    }
  }, [selected])

  const create = async () => {
    const name = newName
    const graph = newKind === 'material'
      ? defaultMaterialGraph(name)
      : defaultLogicGraph(name)
    const error = await saveGraph(name, graph)
    if (error) {
      setError(error)
      return
    }
    setNewName('')
    await materialGraphs.refreshList()
    setSelected({ name, kind: newKind })
  }

  const nameOk = GRAPH_NAME_RE.test(newName) && !list.some(graph => graph.name === newName)

  return (
    <div className={styles.root}>
      <div className={styles.list}>
        {KINDS.map(({ kind, title, empty }) => {
          const graphs = list.filter(graph => graph.kind === kind)
          return (
            <div key={kind} className={styles.kindTitle}>
              <div className={styles.sectionTitle}>{title}</div>
              {graphs.map(graph => (
                <button
                  key={graph.name}
                  className={`${styles.listItem} ${graph.name === selected?.name
                    ? styles.active
                    : ''}`}
                  onClick={() => setSelected({ name: graph.name, kind })}
                >
                  {graph.name}
                </button>
              ))}
              {!graphs.length && <div className={styles.muted}>{empty}</div>}
            </div>
          )
        })}
        <div className={styles.newGraph}>
          <input
            className={styles.text}
            placeholder="new graph name"
            value={newName}
            onChange={e => setNewName(e.target.value.replace(/[^\w-]/g, ''))}
            onKeyDown={(e) => {
              e.stopPropagation()
              if (e.key === 'Enter' && nameOk)
                void create()
            }}
          />
          <select className={styles.kindSelect} value={newKind} onChange={e => setNewKind(e.target.value as GraphKind)}>
            <option value="material">Material</option>
            <option value="logic">Logic</option>
          </select>
          <button disabled={!nameOk} onClick={() => void create()}>New</button>
        </div>
      </div>

      {error && <div className={styles.empty}>{error}</div>}
      {!error && !selected && <div className={styles.empty}>Pick a graph, or make a new one</div>}
      {!error && loaded && (
        <ReactFlowProvider key={loaded.name}>
          <GraphEditor initial={loaded} onSaved={() => void materialGraphs.refreshList()} />
        </ReactFlowProvider>
      )}
    </div>
  )
}
