import type { ShadeMode } from '../../Editor'
import { SHADE_MODES } from './CanvasToolbar'

interface Props {
  shadeMode: ShadeMode
  onChange(mode: ShadeMode): void
  btnClass: string
  activeClass: string
  size?: number
}

export default function ShadeModeButtons({ shadeMode, onChange, btnClass, activeClass, size = 18 }: Props) {
  return (
    <>
      {SHADE_MODES.map(({ mode, label, paths }) => (
        <button
          key={mode}
          title={label}
          className={`${btnClass}${shadeMode === mode ? ` ${activeClass}` : ''}`}
          onClick={() => onChange(mode)}
        >
          <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            {paths.map((d, i) => <path key={i} d={d} />)}
          </svg>
        </button>
      ))}
    </>
  )
}
