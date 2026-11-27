import type { PortSpec } from '@mavonengine/core/Graph/NodeRegistry'
import type { GraphParameter, GraphValue, PinType } from '@mavonengine/core/Graph/types'
import type { GraphAnalysis } from '@mavonengine/core/Graph/validate'
import type { NodeProps } from '@xyflow/react'
import type { FlowNode } from './graphModel'
import { getNode } from '@mavonengine/core/Graph/NodeRegistry'
import { Handle, Position } from '@xyflow/react'
import { createContext, memo, useContext } from 'react'
import { Color } from 'three'
import { PIN_COLORS } from './graphModel'
import styles from './Materials.module.css'

export interface GraphEditorContext {
  analysis?: GraphAnalysis
  parameters: GraphParameter[]
  /** The names of the game's texture resources */
  textures: string[]
  setValue(node: string, key: string, value: GraphValue): void
}

export const GraphContext = createContext<GraphEditorContext>({
  parameters: [],
  textures: [],
  setValue: () => {},
})

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
function ValueField({ type, value, onChange }: { type: PinType | 'number', value: GraphValue | undefined, onChange(v: GraphValue): void }) {
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

/** A setting picked from a list: a texture or a parameter by name */
function ChoiceField({ value, choices, onChange }: { value: string, choices: string[], onChange(v: string): void }) {
  const all = choices.includes(value) || !value
    ? choices
    : [...choices, value]
  return (
    <select className={`${styles.choice} nodrag`} value={value} onChange={e => onChange(e.target.value)}>
      <option value="">—</option>
      {all.map(choice => <option key={choice} value={choice}>{choice}</option>)}
    </select>
  )
}

function port(type: PinType | 'number' | undefined) {
  return { background: PIN_COLORS[type ?? 'number'] ?? PIN_COLORS.number }
}

function GraphNode({ id, data, selected }: NodeProps<FlowNode>) {
  const { analysis, parameters, textures, setValue } = useContext(GraphContext)
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
    <div className={`${styles.node} ${selected ? styles.selected : ''} ${issues.length ? styles.broken : ''}`} title={definition.description}>
      <div className={styles.nodeHeader}>{definition.label}</div>

      {Object.entries(definition.outputs).map(([key, spec]) => (
        <div key={key} className={`${styles.row} ${styles.output}`}>
          <span>{spec.label ?? key}</span>
          <Handle type="source" position={Position.Right} id={key} className={styles.handle} style={port(outputTypes[key] ?? spec.type)} />
        </div>
      ))}

      {Object.entries(definition.settings ?? {}).map(([key, spec]) => (
        <div key={key} className={styles.row}>
          <span>{spec.label ?? key}</span>
          {key === 'name' && data.type === 'input.parameter'
            ? <ChoiceField value={String(data.values.name ?? '')} choices={parameters.map(p => p.name)} onChange={v => setValue(id, key, v)} />
            : key === 'texture'
              ? <ChoiceField value={String(data.values.texture ?? '')} choices={textures} onChange={v => setValue(id, key, v)} />
              : <ValueField type={spec.type} value={value(key, spec)} onChange={v => setValue(id, key, v)} />}
        </div>
      ))}

      {Object.entries(definition.inputs).map(([key, spec]) => (
        <div key={key} className={`${styles.row} ${styles.input}`}>
          <Handle type="target" position={Position.Left} id={key} className={styles.handle} style={port(spec.type)} />
          <span>{spec.label ?? key}</span>
          {!connected[key] && spec.type !== 'texture' && (
            <ValueField type={spec.type} value={value(key, spec)} onChange={v => setValue(id, key, v)} />
          )}
        </div>
      ))}

      {issues.map(issue => <div key={issue.message} className={styles.nodeIssue}>{issue.message}</div>)}
    </div>
  )
}

export default memo(GraphNode)
