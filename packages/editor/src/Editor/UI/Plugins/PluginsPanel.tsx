import type { PluginInfo } from '../../Plugins/pluginsApi'
import type { HttpRouteInfo } from '../../Server/routesApi'
import { getPrefabs } from '@mavonengine/core/Prefab/PrefabRegistry'
import { useCallback, useEffect, useState } from 'react'
import { fetchPlugins, pluginPrefabs } from '../../Plugins/pluginsApi'
import { fetchRoutes } from '../../Server/routesApi'
import tableStyles from '../Server/ServerPanel.module.css'
import Markdown from './Markdown'
import styles from './PluginsPanel.module.css'

const SAFE_URL_RE = /^https?:\/\//i
const GIT_URL_RE = /^git\+|\.git$/g

const TARGETS = { client: 'Client', server: 'Server', both: 'Client + server' }

function Endpoints({ routes, error }: { routes: HttpRouteInfo[] | null, error: string | null }) {
  if (!routes)
    return <p className={styles.muted}>{error ? `Unknown: ${error}` : 'Asking the game server…'}</p>
  if (routes.length === 0)
    return <p className={styles.muted}>It registered no HTTP endpoints on the game server.</p>

  return (
    <div className={tableStyles.tableWrap}>
      <table className={tableStyles.table}>
        <thead>
          <tr>
            {['Method', 'Path', 'Served in', 'What it does'].map(column => <th key={column} scope="col">{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {routes.map(route => (
            <tr key={`${route.method} ${route.path}`}>
              <td className={`${tableStyles.method} ${tableStyles[`method${route.method}`] ?? ''}`}>{route.method}</td>
              <td className={tableStyles.path}>{route.path}</td>
              <td>
                <span className={`${tableStyles.environment} ${route.devOnly ? tableStyles.devOnly : ''}`}>
                  {route.devOnly ? 'Dev only' : 'Prod + dev'}
                </span>
              </td>
              <td className={tableStyles.summary}>{route.summary}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Prefabs({ plugin }: { plugin: PluginInfo }) {
  const prefabs = pluginPrefabs(plugin, getPrefabs())
  if (prefabs.length === 0)
    return <p className={styles.muted}>It has no prefabs.</p>

  return (
    <div className={tableStyles.tableWrap}>
      <table className={tableStyles.table}>
        <thead>
          <tr>
            {['Prefab', 'In the editor', 'Used by this project'].map(column => <th key={column} scope="col">{column}</th>)}
          </tr>
        </thead>
        <tbody>
          {prefabs.map(prefab => (
            <tr key={prefab.name}>
              <td className={tableStyles.path}>
                {prefab.label && prefab.label !== prefab.name ? `${prefab.label} (${prefab.name})` : prefab.name}
              </td>
              <td className={`${styles.nowrap} ${prefab.registered ? '' : styles.muted}`}>
                {prefab.registered ? 'Can be placed from Assets' : 'Not registered in this session'}
              </td>
              <td className={tableStyles.summary}>
                {prefab.used ? 'Yes, its assets ship in a release' : 'No, its assets are left out of a release'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

function Details({ plugin, routes, routesError }: { plugin: PluginInfo, routes: HttpRouteInfo[] | null, routesError: string | null }) {
  const homepage = plugin.homepage?.replace(GIT_URL_RE, '')

  return (
    <article className={styles.details}>
      <header className={styles.header}>
        <h2 className={styles.name}>{plugin.package}</h2>
        <div className={styles.badges}>
          {plugin.version && <span className={styles.badge}>{`v${plugin.version}`}</span>}
          <span className={`${styles.badge} ${plugin.enabled ? styles.on : styles.off}`}>{plugin.enabled ? 'Enabled' : 'Disabled'}</span>
          {plugin.target && <span className={styles.badge}>{TARGETS[plugin.target]}</span>}
        </div>
      </header>

      {plugin.description && <p className={styles.description}>{plugin.description}</p>}

      {plugin.problem && <p className={styles.problem} role="alert">{plugin.problem}</p>}

      <dl className={styles.meta}>
        {plugin.engine && (
          <>
            <dt>Engine</dt>
            <dd>{`@mavonengine/core ${plugin.engine}`}</dd>
          </>
        )}
        {plugin.license && (
          <>
            <dt>License</dt>
            <dd>{plugin.license}</dd>
          </>
        )}
        {homepage && SAFE_URL_RE.test(homepage) && (
          <>
            <dt>Homepage</dt>
            <dd><a href={homepage} target="_blank" rel="noreferrer">{homepage}</a></dd>
          </>
        )}
      </dl>

      <section>
        <h3 className={styles.sectionTitle}>HTTP endpoints</h3>
        <Endpoints routes={routes && routes.filter(route => route.plugin === plugin.package)} error={routesError} />
      </section>

      <section>
        <h3 className={styles.sectionTitle}>Prefabs</h3>
        <Prefabs plugin={plugin} />
      </section>

      <section>
        <h3 className={styles.sectionTitle}>Readme</h3>
        {plugin.readme ? <Markdown source={plugin.readme} /> : <p className={styles.muted}>The package has no readme.</p>}
      </section>
    </article>
  )
}

/**
 * The plugins in the project's mavonengine.json: what each is, and which HTTP endpoints and prefabs come from it.
 * Plugin details come from the dev server, endpoints from the game server, prefabs from the running editor.
 */
export default function PluginsPanel({ fetchFn }: { fetchFn?: typeof fetch }) {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [routes, setRoutes] = useState<HttpRouteInfo[] | null>(null)
  const [routesError, setRoutesError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)

  const load = useCallback(async () => {
    await Promise.all([
      fetchPlugins(fetchFn).then((list) => {
        setPlugins(list.plugins)
        setError(null)
      }, (err: Error) => setError(err.message)),
      // A game without a server still has plugins: only their endpoints stay unknown
      fetchRoutes(fetchFn).then((list) => {
        setRoutes(list)
        setRoutesError(null)
      }, (err: Error) => {
        setRoutes(null)
        setRoutesError(err.message)
      }),
    ])
  }, [fetchFn])

  useEffect(() => {
    void load()
  }, [load])

  const current = plugins?.find(plugin => plugin.package === selected) ?? plugins?.[0]

  return (
    <div className={styles.root}>
      <div className={styles.toolbar}>
        <span className={styles.title}>
          Plugins
          {plugins ? ` (${plugins.length})` : ''}
        </span>
        <button className={styles.refresh} onClick={() => void load()}>Refresh</button>
      </div>

      {error && <div className={styles.problem} role="alert">{error}</div>}

      {!plugins && !error && <div className={styles.empty}>Asking the dev server for the project&apos;s plugins…</div>}

      {plugins && plugins.length === 0 && (
        <div className={styles.empty}>
          This project has no plugins. Add one with
          {' '}
          <code>mavonengine install &lt;package&gt;</code>
          .
        </div>
      )}

      {plugins && current && (
        <div className={styles.columns}>
          <ul className={styles.list} aria-label="Plugins">
            {plugins.map(plugin => (
              <li key={plugin.package}>
                <button
                  className={`${styles.item} ${plugin === current ? styles.selected : ''}`}
                  aria-current={plugin === current}
                  onClick={() => setSelected(plugin.package)}
                >
                  <span className={styles.itemName}>{plugin.package}</span>
                  <span className={styles.itemMeta}>
                    {plugin.problem ? 'Problem' : plugin.enabled ? `v${plugin.version ?? '?'}` : 'Disabled'}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <Details plugin={current} routes={routes} routesError={routesError} />
        </div>
      )}
    </div>
  )
}
