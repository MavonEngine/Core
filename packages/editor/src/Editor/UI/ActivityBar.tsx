import { useState } from 'react'
import styles from './ActivityBar.module.css'

const icons = [
  { id: 'explorer', label: 'Explorer', path: 'M17.5 0h-9L7 1.5V6H2.5L1 7.5v13l1.5 1.5h13l1.5-1.5V16h4.5l1.5-1.5v-13L22 0h-4.5zM16 20.5H2.5V7.5H7v8L8.5 17h7.5v3.5zm5.5-6H8.5V1.5h9v4.5H22v8.5z' },
  { id: 'search', label: 'Search', path: 'M15.25 0a8.25 8.25 0 0 0-6.18 13.72L1 21.79l1.42 1.42 8.07-8.07A8.25 8.25 0 1 0 15.25 0zm0 15a6.75 6.75 0 1 1 0-13.5 6.75 6.75 0 0 1 0 13.5z' },
  { id: 'git', label: 'Source Control', path: 'M21.007 8.222A3.738 3.738 0 0 0 15.045 5.2a3.737 3.737 0 0 0 1.156 6.583 2.988 2.988 0 0 1-2.668 1.67h-2.99a4.456 4.456 0 0 0-2.989 1.165V7.4a3.737 3.737 0 1 0-1.494 0v9.117a3.776 3.776 0 1 0 1.816.099 2.99 2.99 0 0 1 2.668-1.667h2.99a4.484 4.484 0 0 0 4.223-3.039 3.736 3.736 0 0 0 3.25-3.687zM4.565 3.738a2.242 2.242 0 1 1 4.484 0 2.242 2.242 0 0 1-4.484 0zm4.484 16.441a2.242 2.242 0 1 1-4.484 0 2.242 2.242 0 0 1 4.484 0zm8.221-9.715a2.242 2.242 0 1 1 0-4.485 2.242 2.242 0 0 1 0 4.485z' },
  { id: 'extensions', label: 'Extensions', path: 'M13.5 1.5L15 0h7.5L24 1.5V9l-1.5 1.5H15L13.5 9V1.5zm1.5 0V9h7.5V1.5H15zM0 15L1.5 13.5H9L10.5 15v7.5L9 24H1.5L0 22.5V15zm1.5 0v7.5H9V15H1.5zm6-13.5L9 0h7.5L18 1.5V9l-1.5 1.5H9L7.5 9V1.5zM9 1.5V9h7.5V1.5H9zM0 1.5L1.5 0H9l1.5 1.5V9L9 10.5H1.5L0 9V1.5zm1.5 0V9H9V1.5H1.5z' },
  { id: 'settings', label: 'Settings', path: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.49.49 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94L14.4.37A.49.49 0 0 0 13.92 0h-3.84a.49.49 0 0 0-.48.37l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96a.49.49 0 0 0-.59.22L2.72 6.87a.48.48 0 0 0 .12.61l2.03 1.58c-.05.3-.07.62-.07.94s.02.64.07.94L2.84 12.52a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.37.48.37h3.84c.24 0 .44-.14.48-.37l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6A3.6 3.6 0 1 1 12 8.4a3.6 3.6 0 0 1 0 7.2z' },
]

export default function ActivityBar() {
  const [active, setActive] = useState('explorer')

  return (
    <div className={styles.activityBar}>
      {icons.map(icon => (
        <div
          key={icon.id}
          title={icon.label}
          onClick={() => setActive(icon.id)}
          className={`${styles.icon} ${active === icon.id ? styles.active : ''}`}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill={active === icon.id ? 'var(--icon-active)' : 'var(--icon-default)'}>
            <path d={icon.path} />
          </svg>
        </div>
      ))}
    </div>
  )
}
