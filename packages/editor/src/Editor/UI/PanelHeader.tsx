import styles from './PanelHeader.module.css'

export default function PanelHeader({ title }: { title: string }) {
  return (
    <div className={styles.panelHeader}>
      {title}
    </div>
  )
}
