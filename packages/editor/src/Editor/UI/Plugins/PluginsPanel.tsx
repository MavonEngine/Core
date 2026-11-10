import type { AvailablePlugin, InstallStatus, PluginInfo } from '../../Plugins/pluginsApi'
import type { HttpRouteInfo } from '../../Server/routesApi'
import type { InstallRequest } from './InstallDialog'
import { invalidPackages } from '@mavonengine/core/Plugins/install'
import { getPrefabs } from '@mavonengine/core/Prefab/PrefabRegistry'
import { useCallback, useEffect, useState } from 'react'
import { fetchAvailablePlugins, fetchAvailableReadme, fetchInstallStatus, fetchPlugins, pluginPrefabs } from '../../Plugins/pluginsApi'
import { fetchRoutes } from '../../Server/routesApi'
import tableStyles from '../Server/ServerPanel.module.css'
import InstallDialog from './InstallDialog'
import Markdown from './Markdown'
import styles from './PluginsPanel.module.css'

const SAFE_URL_RE = /^https?:\/\//i
const GIT_URL_RE = /^git\+|\.git$/g
const WHITESPACE_RE = /\s+/

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

/** A plugin from the public list that the project doesn't have: what it is and how to get it */
function AvailableDetails({ plugin, install, onInstall, fetchFn }: { plugin: AvailablePlugin, install: InstallStatus | null, onInstall(request: InstallRequest): void, fetchFn?: typeof fetch }) {
  // The readme of the plugin it was read for, so one that arrives late never shows under another plugin
  const [readme, setReadme] = useState<{ of: string, markdown?: string, error?: string } | null>(null)

  useEffect(() => {
    if (!plugin.readme)
      return

    let current = true
    fetchAvailableReadme(plugin, fetchFn).then(
      markdown => current && setReadme({ of: plugin.package, markdown }),
      (err: Error) => current && setReadme({ of: plugin.package, error: err.message }),
    )
    return () => {
      current = false
    }
  }, [plugin, fetchFn])

  const loaded = readme?.of === plugin.package ? readme : null

  return (
    <article className={styles.details}>
      <header className={styles.header}>
        <h2 className={styles.name}>{plugin.name}</h2>
        <div className={styles.badges}>
          <span className={styles.badge}>Not installed</span>
          {plugin.target && <span className={styles.badge}>{TARGETS[plugin.target]}</span>}
        </div>
      </header>

      {plugin.description && <p className={styles.description}>{plugin.description}</p>}

      <dl className={styles.meta}>
        <dt>Package</dt>
        <dd>{plugin.package}</dd>
        {plugin.engine && (
          <>
            <dt>Engine</dt>
            <dd>{`@mavonengine/core ${plugin.engine}`}</dd>
          </>
        )}
        {plugin.homepage && SAFE_URL_RE.test(plugin.homepage) && (
          <>
            <dt>Homepage</dt>
            <dd><a href={plugin.homepage} target="_blank" rel="noreferrer">{plugin.homepage}</a></dd>
          </>
        )}
      </dl>

      <section>
        <h3 className={styles.sectionTitle}>Install</h3>
        {install?.available
          ? (
              <>
                <button className={styles.install} onClick={() => onInstall({ packages: [plugin.package], homepage: plugin.homepage })}>
                  {`Install ${plugin.package}…`}
                </button>
                <p className={styles.muted}>Installs it into the project and restarts the dev servers. Or run this yourself:</p>
              </>
            )
          : (
              <p className={styles.muted}>
                {install?.reason ? `${install.reason}. ` : ''}
                Run this in the project, then reload the editor. A server plugin needs the game server restarted.
              </p>
            )}
        <pre className={styles.command}><code>{`npx @mavonengine/cli install ${plugin.package}`}</code></pre>
      </section>

      <section>
        <h3 className={styles.sectionTitle}>Readme</h3>
        {!plugin.readme && <p className={styles.muted}>The list of plugins has no readme for it.</p>}
        {plugin.readme && !loaded && <p className={styles.muted}>Reading its readme…</p>}
        {loaded?.error && <p className={styles.muted}>{`Could not read its readme: ${loaded.error}`}</p>}
        {loaded?.markdown !== undefined && <Markdown source={loaded.markdown} />}
      </section>
    </article>
  )
}

/** Install something that isn't on the list: any package the package manager takes */
function InstallOther({ onInstall }: { onInstall(request: InstallRequest): void }) {
  const [spec, setSpec] = useState('')
  const [problem, setProblem] = useState<string | null>(null)

  return (
    <form
      className={styles.other}
      onSubmit={(event) => {
        event.preventDefault()
        const packages = spec.trim().split(WHITESPACE_RE).filter(Boolean)
        const invalid = invalidPackages(packages)
        setProblem(invalid ?? null)
        if (!invalid)
          onInstall({ packages })
      }}
    >
      <label className={styles.otherLabel}>
        Another package
        <input
          className={styles.otherInput}
          value={spec}
          placeholder="name, name@version or URL"
          spellCheck={false}
          onChange={event => setSpec(event.target.value)}
        />
      </label>
      <button className={styles.refresh} disabled={!spec.trim()}>Install…</button>
      {problem && <p className={styles.problem} role="alert">{problem}</p>}
    </form>
  )
}

/**
 * The plugins in the project's mavonengine.json: what each is, and which HTTP endpoints and prefabs come from it.
 * Plugin details come from the dev server, endpoints from the game server, prefabs from the running editor.
 * Below them, the plugins that can be installed: the public list on GitHub, without the ones the project has.
 */
export default function PluginsPanel({ fetchFn }: { fetchFn?: typeof fetch }) {
  const [plugins, setPlugins] = useState<PluginInfo[] | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [routes, setRoutes] = useState<HttpRouteInfo[] | null>(null)
  const [routesError, setRoutesError] = useState<string | null>(null)
  const [available, setAvailable] = useState<AvailablePlugin[] | null>(null)
  const [availableError, setAvailableError] = useState<string | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [install, setInstall] = useState<InstallStatus | null>(null)
  const [installing, setInstalling] = useState<InstallRequest | null>(null)

  const load = useCallback(async () => {
    await Promise.all([
      fetchPlugins(fetchFn).then(async (list) => {
        setPlugins(list.plugins)
        setError(null)
        // After the project's own, to leave those out
        await fetchAvailablePlugins(list.plugins, fetchFn).then((rest) => {
          setAvailable(rest)
          setAvailableError(null)
        }, (err: Error) => setAvailableError(err.message))
      }, (err: Error) => setError(err.message)),
      fetchInstallStatus(fetchFn).then(setInstall),
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

  const current = plugins?.find(plugin => plugin.package === selected)
  const currentAvailable = current ? undefined : available?.find(plugin => plugin.package === selected)
  // Nothing picked yet: the project's first plugin, or the first one to install when it has none
  const shown = current ?? currentAvailable ?? plugins?.[0] ?? available?.[0]

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

      {plugins && (
        <div className={styles.columns}>
          <div className={styles.lists}>
            {plugins.length === 0
              ? (
                  <div className={styles.note}>
                    This project has no plugins. Add one with
                    {' '}
                    <code>mavonengine install &lt;package&gt;</code>
                    .
                  </div>
                )
              : (
                  <ul className={styles.list} aria-label="Plugins">
                    {plugins.map(plugin => (
                      <li key={plugin.package}>
                        <button
                          className={`${styles.item} ${plugin === shown ? styles.selected : ''}`}
                          aria-current={plugin === shown}
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
                )}

            <h3 className={styles.sectionTitle}>
              Available to install
              {available ? ` (${available.length})` : ''}
            </h3>
            {availableError && <div className={styles.note} role="status">{`Could not read the list of plugins: ${availableError}`}</div>}
            {!available && !availableError && <div className={styles.note}>Reading the list from GitHub…</div>}
            {available && available.length === 0 && <div className={styles.note}>The project has every plugin on the list.</div>}
            {install?.available && <InstallOther onInstall={setInstalling} />}
            {available && available.length > 0 && (
              <ul className={styles.list} aria-label="Available plugins">
                {available.map(plugin => (
                  <li key={plugin.package}>
                    <button
                      className={`${styles.item} ${plugin === shown ? styles.selected : ''}`}
                      aria-current={plugin === shown}
                      onClick={() => setSelected(plugin.package)}
                    >
                      <span className={styles.itemName}>{plugin.package}</span>
                      <span className={styles.itemMeta}>{plugin.description ?? plugin.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </div>

          {shown && ('enabled' in shown
            ? <Details plugin={shown} routes={routes} routesError={routesError} />
            : <AvailableDetails plugin={shown} install={install} onInstall={setInstalling} fetchFn={fetchFn} />)}
        </div>
      )}

      {installing && (
        <InstallDialog
          request={installing}
          fetchFn={fetchFn}
          onClose={() => {
            setInstalling(null)
            // What was installed may already be in the project
            void load()
          }}
        />
      )}
    </div>
  )
}
