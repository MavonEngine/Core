import styles from './ActivityBar.module.css'

/** What the editor shows next to the activity bar: the scene editor itself, or a view that takes its place */
export type Activity = 'scene' | 'server'

const icons: { id: Activity, label: string, path: string, evenOdd?: boolean }[] = [
  { id: 'scene', label: 'Scene', path: 'M17.5 0h-9L7 1.5V6H2.5L1 7.5v13l1.5 1.5h13l1.5-1.5V16h4.5l1.5-1.5v-13L22 0h-4.5zM16 20.5H2.5V7.5H7v8L8.5 17h7.5v3.5zm5.5-6H8.5V1.5h9v4.5H22v8.5z' },
  { id: 'server', label: 'Server', evenOdd: true, path: 'M2 3h20v8H2V3zm0 10h20v8H2v-8zm3-7.25a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5zm0 10a1.25 1.25 0 1 0 0 2.5 1.25 1.25 0 0 0 0-2.5zM9 6.25v1.5h10v-1.5H9zm0 10v1.5h10v-1.5H9z' },
]

export default function ActivityBar({ active, onSelect }: { active: Activity, onSelect(activity: Activity): void }) {
  return (
    <div className={styles.activityBar}>
      {icons.map(icon => (
        <div
          key={icon.id}
          role="button"
          aria-pressed={active === icon.id}
          aria-label={icon.label}
          title={icon.label}
          onClick={() => onSelect(icon.id)}
          className={`${styles.icon} ${active === icon.id ? styles.active : ''}`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill={active === icon.id ? 'var(--icon-active)' : 'var(--icon-default)'}>
            <path d={icon.path} fillRule={icon.evenOdd ? 'evenodd' : undefined} />
          </svg>
        </div>
      ))}
    </div>
  )
}
