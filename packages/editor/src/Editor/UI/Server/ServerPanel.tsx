import type { HttpRouteInfo } from '../../Server/routesApi'
import { useCallback, useEffect, useRef, useState } from 'react'
import { fetchRoutes, groupRoutes, serverUrl } from '../../Server/routesApi'
import styles from './ServerPanel.module.css'

/** How often the list is read again while the panel is shown */
export const ROUTES_REFRESH_MS = 5000

/** How often it looks whether its tab was opened */
const VISIBILITY_CHECK_MS = 300

const PARAM_RE = /:\w+/

function routeKey(route: HttpRouteInfo) {
  return `${route.method} ${route.path}`
}

function Descriptions({ title, entries }: { title: string, entries: Record<string, string> | undefined }) {
  const names = Object.keys(entries ?? {})
  if (names.length === 0)
    return null

  return (
    <>
      <dt>{title}</dt>
      <dd>
        {names.map(name => (
          <div key={name} className={styles.field}>
            <code>{name}</code>
            <span>{entries![name]}</span>
          </div>
        ))}
      </dd>
    </>
  )
}

const COLUMNS = ['Method', 'Path', 'Served in', 'From', 'What it does']

function Route({ route, from, open, onToggle }: { route: HttpRouteInfo, from: string, open: boolean, onToggle(): void }) {
  // Only something a browser can open as it is: a GET without parameters to fill in
  const openable = route.method === 'GET' && !PARAM_RE.test(route.path)
  const described = !!(route.description || route.response || route.auth || route.query || Object.keys(route.params).length)

  return (
    <>
      <tr
        className={styles.row}
        tabIndex={0}
        aria-expanded={open}
        onClick={onToggle}
        onKeyDown={(event) => {
          if (event.key === 'Enter' || event.key === ' ') {
            event.preventDefault()
            onToggle()
          }
        }}
      >
        <td className={`${styles.method} ${styles[`method${route.method}`] ?? ''}`}>{route.method}</td>
        <td className={styles.path}>{route.path}</td>
        <td>
          <span
            className={`${styles.environment} ${route.devOnly ? styles.devOnly : ''}`}
            title={route.devOnly ? 'Only exists in development' : 'Served in production and in development'}
          >
            {route.devOnly ? 'Dev only' : 'Prod + dev'}
          </span>
        </td>
        <td className={styles.from}>{from}</td>
        <td className={styles.summary}>{route.summary}</td>
      </tr>

      {open && (
        <tr className={styles.detailsRow}>
          <td colSpan={COLUMNS.length}>
            <dl className={styles.details}>
              {route.description && (
                <>
                  <dt>About</dt>
                  <dd>{route.description}</dd>
                </>
              )}
              <Descriptions title="Path" entries={route.params} />
              <Descriptions title="Query" entries={route.query} />
              {route.response && (
                <>
                  <dt>Answers</dt>
                  <dd>{route.response}</dd>
                </>
              )}
              {route.auth && (
                <>
                  <dt>Access</dt>
                  <dd>{route.auth}</dd>
                </>
              )}
              {!described && (
                <>
                  <dt>About</dt>
                  <dd className={styles.muted}>
                    Not described. Put
                    {' '}
                    <code>describeRoute()</code>
                    {' '}
                    in front of its handler to say what it does.
                  </dd>
                </>
              )}
              {openable && (
                <>
                  <dt>Try</dt>
                  <dd><a href={`${serverUrl()}${route.path}`} target="_blank" rel="noreferrer">Open in a new tab</a></dd>
                </>
              )}
            </dl>
          </td>
        </tr>
      )}
    </>
  )
}

/**
 * The game server's HTTP endpoints: the engine's, the game's own and those of plugins.
 * Read from the running server, so it shows what the server answers right now.
 */
export default function ServerPanel({ fetchFn }: { fetchFn?: typeof fetch }) {
  const root = useRef<HTMLDivElement>(null)
  const [routes, setRoutes] = useState<HttpRouteInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [opened, setOpened] = useState<Set<string>>(() => new Set())

  const load = useCallback(async () => {
    try {
      setRoutes(await fetchRoutes(fetchFn))
      setError(null)
    }
    catch (err) {
      setError((err as Error).message)
    }
  }, [fetchFn])

  useEffect(() => {
    let shown = false
    let loadedAt = 0

    // The panel stays mounted while another tab of its dock is shown, and a game may have no server at all:
    // only ask while it is visible, right when it is opened and every few seconds after
    const check = () => {
      const visible = !!root.current?.offsetParent
      if (visible && (!shown || Date.now() - loadedAt >= ROUTES_REFRESH_MS)) {
        loadedAt = Date.now()
        void load()
      }
      shown = visible
    }

    check()
    const timer = setInterval(check, VISIBILITY_CHECK_MS)
    return () => clearInterval(timer)
  }, [load])

  const toggle = (key: string) => setOpened((before) => {
    const next = new Set(before)
    if (!next.delete(key))
      next.add(key)
    return next
  })

  return (
    <div ref={root} className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.title}>
          HTTP endpoints
          {routes ? ` (${routes.length})` : ''}
        </span>
        <button className={styles.refresh} onClick={() => void load()}>Refresh</button>
      </div>

      {error && <div className={styles.error} role="alert">{error}</div>}

      {!routes && !error && <div className={styles.empty}>Asking the game server for its endpoints…</div>}

      {routes && routes.length === 0 && <div className={styles.empty}>The game server has no endpoints</div>}

      {routes && routes.length > 0 && (
        <div className={styles.tableWrap}>
          <table className={styles.table}>
            <thead>
              <tr>
                {COLUMNS.map(column => <th key={column} scope="col">{column}</th>)}
              </tr>
            </thead>
            <tbody>
              {groupRoutes(routes).flatMap(group => group.routes.map(route => (
                <Route
                  key={routeKey(route)}
                  route={route}
                  from={group.from}
                  open={opened.has(routeKey(route))}
                  onToggle={() => toggle(routeKey(route))}
                />
              )))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
