import type { GraphData, GraphParameter, GraphValue, PinType } from '@mavonengine/core/Graph/types'
import type { GraphIssue } from '@mavonengine/core/Graph/validate'
import type { Connection, NodeTypes } from '@xyflow/react'
import type { Material } from 'three'
import type { FlowEdge, FlowNode } from './graphModel'
import type { GraphEditorContext } from './GraphNode'
import Game from '@mavonengine/core/Game'
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
import { defaultMaterialGraph, defaultValue, edgeId, fromFlow, graphKey, newNodeId, PIN_COLORS, toFlow } from './graphModel'
import GraphNode, { GraphContext } from './GraphNode'
import MaterialPreview from './MaterialPreview'
import styles from './Materials.module.css'
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

/** Picks a node type to add, at where the canvas was right clicked */
function NodePalette({ at, onPick, onClose }: { at: { x: number, y: number }, onPick(type: string): void, onClose(): void }) {
  const [filter, setFilter] = useState('')
  const nodes = getNodes('material').filter(node => `${node.category} ${node.label} ${node.type}`.toLowerCase().includes(filter.toLowerCase()))
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
  const [compiled, setCompiled] = useState<{ material?: Material, issues: GraphIssue[] }>({ issues: [] })
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
      // Also puts it on the scene's meshes that use this graph
      setCompiled({ material: materialGraphs.set(graph.name, graph).material, issues: [] })
    }
    catch (err) {
      setCompiled(previous => ({
        // The last material that compiled stays on the preview
        material: previous.material,
        issues: err instanceof MaterialGraphError
          ? err.issues
          : [
              { message: (err as Error).message },
            ],
      }))
    }
  }, [key])
  const { material, issues } = compiled

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
    setValue,
  }), [analysis, parameters, setValue])

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
            edges={edges}
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
          {palette && <NodePalette at={palette.screen} onPick={addNode} onClose={() => setPalette(undefined)} />}
          <div className={styles.hint}>Right click to add a node · Delete removes the selection</div>
        </div>

        <div className={styles.side}>
          <MaterialPreview material={material} />
          <div className={styles.section}>
            <div className={styles.toolbar}>
              <strong>{graph.name}</strong>
              <button disabled={!dirty} onClick={() => void save()}>{dirty ? 'Save' : 'Saved'}</button>
            </div>
            {status && <div className={styles.muted}>{status}</div>}
          </div>
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

/**
 * The project's material graphs: pick or create one on the left, edit it in the node canvas, see it on the preview
 * sphere and on every mesh in the scene that uses it as it changes.
 */
export default function MaterialsView() {
  registerBuiltinNodes()
  const list = useSyncExternalStore(useCallback(listener => materialGraphs.subscribe(listener), []), () => materialGraphs.list)
  const materials = list.filter(graph => graph.kind === 'material')
  const [selected, setSelected] = useState<string>()
  const [loaded, setLoaded] = useState<GraphData>()
  const [error, setError] = useState<string>()
  const [newName, setNewName] = useState('')

  useEffect(() => {
    void materialGraphs.refreshList()
  }, [])

  useEffect(() => {
    setLoaded(undefined)
    setError(undefined)
    if (!selected)
      return
    let live = true
    materialGraphs.graph(selected).then(
      graph => live && setLoaded(graph),
      (err: Error) => live && setError(err.message),
    )
    return () => {
      live = false
    }
  }, [selected])

  const create = async () => {
    const name = newName
    const error = await saveGraph(name, defaultMaterialGraph(name))
    if (error) {
      setError(error)
      return
    }
    setNewName('')
    await materialGraphs.refreshList()
    setSelected(name)
  }

  const nameOk = GRAPH_NAME_RE.test(newName) && !list.some(graph => graph.name === newName)

  return (
    <div className={styles.root}>
      <div className={styles.list}>
        <div className={styles.sectionTitle}>Material graphs</div>
        {materials.map(graph => (
          <button
            key={graph.name}
            className={`${styles.listItem} ${graph.name === selected
              ? styles.active
              : ''}`}
            onClick={() => setSelected(graph.name)}
          >
            {graph.name}
          </button>
        ))}
        {!materials.length && <div className={styles.muted}>No material graphs yet</div>}
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
          <button disabled={!nameOk} onClick={() => void create()}>New</button>
        </div>
      </div>

      {error && <div className={styles.empty}>{error}</div>}
      {!error && !selected && <div className={styles.empty}>Pick a material graph, or make a new one</div>}
      {!error && loaded && (
        <ReactFlowProvider key={loaded.name}>
          <GraphEditor initial={loaded} onSaved={() => void materialGraphs.refreshList()} />
        </ReactFlowProvider>
      )}
    </div>
  )
}
