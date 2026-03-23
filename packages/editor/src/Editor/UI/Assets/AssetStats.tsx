import styles from './AssetStats.module.css'

interface Stat {
  label: string
  value: string
}

export default ({ stats }: { stats: Stat[] }) => (
  <div className={styles.stats}>
    {stats.map(({ label, value }) => (
      <div key={label} className={styles.stat}>
        <span className={styles.label}>{label}</span>
        <span className={styles.value}>{value}</span>
      </div>
    ))}
  </div>
)
