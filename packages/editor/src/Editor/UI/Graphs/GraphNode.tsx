import type { PortSpec } from '@mavonengine/core/Graph/NodeRegistry'
import type { GraphParameter, GraphValue, PortType } from '@mavonengine/core/Graph/types'
import type { GraphAnalysis } from '@mavonengine/core/Graph/validate'
import type { NodeProps } from '@xyflow/react'
import type { FlowNode } from './graphModel'
import { getNode } from '@mavonengine/core/Graph/NodeRegistry'
import { Handle, Position } from '@xyflow/react'
import { createContext, memo, useContext } from 'react'
import { Color } from 'three'
import { PIN_COLORS } from './graphModel'
import styles from './Graphs.module.css'

export interface GraphEditorContext {
  analysis?: GraphAnalysis
  parameters: GraphParameter[]
  /** The names of the game's texture resources */
  textures: string[]
  /** The scene's objects, for entity inputs */
  entities: { value: string, label: string }[]
  /** Nodes that ran a moment ago, lit up while a logic graph runs */
  active: Set<string>
  setValue(node: string, key: string, value: GraphValue): void
}

export const GraphContext = createContext<GraphEditorContext>({
  parameters: [],
  textures: [],
  entities: [],
  active: new Set(),
  setValue: () => {},
})

const COMPARE_OPS = ['<', '<=', '==', '!=', '>=', '>']

/** Hex for a color input, from a linear color value */
export function toHex(value: GraphValue | undefined): string {
  const [r = 1, g = 1, b = 1] = Array.isArray(value)
    ? value
    : [
        Number(value ?? 1),
      ]
  return `#${new Color(r, g, b).getHexString()}`
}

/** A linear color value from a color input's hex */
export function fromHex(hex: string): number[] {
  const color = new Color(hex)
  return [color.r, color.g, color.b].map(n => Math.round(n * 1e4) / 1e4)
}

function NumberField({ value, onChange }: { value: number, onChange(v: number): void }) {
  return (
    <input
      className={`${styles.number} nodrag`}
      type="number"
      step={0.1}
      defaultValue={value}
      key={value}
      onBlur={e => onChange(Number(e.target.value) || 0)}
      onKeyDown={(e) => {
        e.stopPropagation()
        if (e.key === 'Enter')
          (e.target as HTMLInputElement).blur()
      }}
    />
  )
}

/** Edits a value of `type` written on the node */
function ValueField({ type, value, onChange }: { type: PortType, value: GraphValue | undefined, onChange(v: GraphValue): void }) {
  if (type === 'color')
    return <input className={`${styles.color} nodrag`} type="color" value={toHex(value)} onChange={e => onChange(fromHex(e.target.value))} />

  const size = { vec2: 2, vec3: 3, vec4: 4 }[type as string]
  if (size) {
    const v = Array.isArray(value)
      ? value
      : Array.from<number>({ length: size }).fill(Number(value ?? 0))
    return (
      <span className={styles.vector}>
        {Array.from({ length: size }, (_, i) => (
          <NumberField
            key={i}
            value={v[i] ?? 0}
            onChange={(n) => {
              const next = [...v]
              next[i] = n
              onChange(next)
            }}
          />
        ))}
      </span>
    )
  }
  if (type === 'bool')
    return <input className="nodrag" type="checkbox" checked={!!value} onChange={e => onChange(e.target.checked)} />
  if (type === 'string')
    return <input className={`${styles.text} nodrag`} defaultValue={String(value ?? '')} onBlur={e => onChange(e.target.value)} />

  return (
    <NumberField
      value={typeof value === 'number'
        ? value
        : 0}
      onChange={onChange}
    />
  )
}

type Choice = string | { value: string, label: string }

/** A setting picked from a list: a texture, a parameter, a scene object... */
function ChoiceField({ value, choices, empty = '—', onChange }: { value: string, choices: Choice[], empty?: string | false, onChange(v: string): void }) {
  const options = choices.map(choice => typeof choice === 'string'
    ? { value: choice, label: choice }
    : choice)
  if (value && !options.some(option => option.value === value))
    options.push({ value, label: value })
  return (
    <select className={`${styles.choice} nodrag`} value={value} onChange={e => onChange(e.target.value)}>
      {empty !== false && <option value="">{empty}</option>}
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  )
}

function port(type: PortType | undefined) {
  return { background: PIN_COLORS[type ?? 'number'] ?? PIN_COLORS.number }
}

function handleClass(type: PortType | undefined) {
  return type === 'exec'
    ? `${styles.handle} ${styles.execHandle}`
    : styles.handle
}

function GraphNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { analysis, parameters, textures, entities, active, setValue } = useContext(GraphContext)
  const definition = getNode(data.type)

  if (!definition) {
    return (
      <div className={`${styles.node} ${styles.broken}`}>
        <div className={styles.nodeHeader}>{data.type}</div>
        <div className={styles.nodeIssue}>Unknown node type</div>
      </div>
    )
  }

  const connected = analysis?.incoming.get(id) ?? {}
  const outputTypes = analysis?.outputTypes.get(id) ?? {}
  const issues = analysis?.issues.filter(issue => issue.node === id) ?? []
  const value = (key: string, spec: PortSpec) => data.values[key] ?? spec.default

  return (
    <div
      className={`${styles.node} ${selected ? styles.selected : ''} ${issues.length ? styles.broken : ''} ${active.has(id)
        ? styles.running
        : ''} ${definition.trigger ? styles.event : ''}`}
      title={definition.description}
    >
      <div className={styles.nodeHeader}>{definition.label}</div>

      {Object.entries(definition.outputs).map(([key, spec]) => (
        <div key={key} className={`${styles.row} ${styles.output}`}>
          <span>{spec.label ?? key}</span>
          <Handle type="source" position={Position.Right} id={key} className={handleClass(spec.type)} style={port(outputTypes[key] ?? spec.type)} />
        </div>
      ))}

      {Object.entries(definition.settings ?? {}).map(([key, spec]) => (
        <div key={key} className={styles.row}>
          <span>{spec.label ?? key}</span>
          {(() => {
            const current = String(value(key, spec) ?? '')
            const pick = (choices: Choice[], empty?: string | false) => <ChoiceField value={current} choices={choices} empty={empty} onChange={v => setValue(id, key, v)} />
            if (key === 'name' && data.type === 'input.parameter')
              return pick(parameters.map(p => p.name))
            if (key === 'texture')
              return pick(textures)
            if (key === 'op' && data.type === 'logic.compare')
              return pick(COMPARE_OPS, false)
            if (key === 'id' && data.type === 'entity.byId')
              return pick(entities)
            return <ValueField type={spec.type} value={value(key, spec)} onChange={v => setValue(id, key, v)} />
          })()}
        </div>
      ))}

      {Object.entries(definition.inputs).map(([key, spec]) => (
        <div key={key} className={`${styles.row} ${styles.input}`}>
          <Handle type="target" position={Position.Left} id={key} className={handleClass(spec.type)} style={port(spec.type)} />
          <span>{spec.label ?? key}</span>
          {!connected[key] && spec.type === 'entity' && (
            <ChoiceField value={String(value(key, spec) ?? '')} choices={entities} empty="Self" onChange={v => setValue(id, key, v)} />
          )}
          {!connected[key] && spec.type === 'any' && (
            <ValueField
              type={typeof value(key, spec) === 'string'
                ? 'string'
                : 'float'}
              value={value(key, spec)}
              onChange={v => setValue(id, key, v)}
            />
          )}
          {!connected[key] && !['texture', 'exec', 'entity', 'any'].includes(spec.type) && (
            <ValueField type={spec.type} value={value(key, spec)} onChange={v => setValue(id, key, v)} />
          )}
        </div>
      ))}

      {issues.map(issue => <div key={issue.message} className={styles.nodeIssue}>{issue.message}</div>)}
    </div>
  )
}

export default memo(GraphNode)
