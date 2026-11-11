import type { InstallJob } from '../../Plugins/pluginsApi'
import { useEffect, useId, useState } from 'react'
import { fetchInstallStatus, startInstall } from '../../Plugins/pluginsApi'
import styles from './InstallDialog.module.css'

/** How often the install is asked about while it runs */
export const INSTALL_POLL_MS = 1000

const PACKAGE_NAME_RE = /^(?:@[\w.-]+\/)?[\w.-]+/
const SAFE_URL_RE = /^https?:\/\//i

export interface InstallRequest {
  /** What is handed to the package manager: names, name@version, file: paths, URLs */
  packages: string[]
  /** Where the source can be looked at, when the list of plugins says */
  homepage?: string
}

/** Where to look at what `spec` installs: the list's homepage, the URL itself, or its page on npm */
export function sourceOf(spec: string, homepage?: string): string | undefined {
  if (homepage && SAFE_URL_RE.test(homepage))
    return homepage
  if (SAFE_URL_RE.test(spec))
    return spec
  if (spec.includes(':') || spec.startsWith('.') || spec.startsWith('/') || spec.startsWith('~'))
    return undefined

  const name = PACKAGE_NAME_RE.exec(spec)?.[0]
  return name ? `https://www.npmjs.com/package/${name}` : undefined
}

type Phase = 'confirm' | 'starting' | 'installing' | 'restarting' | 'done' | 'failed'

/**
 * Asks before anything is installed, then shows how the install goes.
 *
 * A package runs its own code on the machine, when it is installed and whenever the game runs, and nothing
 * checks what it does. So the dialog says so, points at the source and only installs once the person
 * has ticked that they looked at it.
 */
export default function InstallDialog({ request, onClose, fetchFn }: { request: InstallRequest, onClose(): void, fetchFn?: typeof fetch }) {
  const titleId = useId()
  const [checked, setChecked] = useState(false)
  const [phase, setPhase] = useState<Phase>('confirm')
  const [job, setJob] = useState<InstallJob | null>(null)
  const [error, setError] = useState<string | null>(null)

  const names = request.packages.join(', ')
  const running = phase === 'starting' || phase === 'installing' || phase === 'restarting'

  useEffect(() => {
    if (!job || (phase !== 'installing' && phase !== 'restarting'))
      return

    const timer = setInterval(async () => {
      const status = await fetchInstallStatus(fetchFn)
      const current = status.job?.id === job.id ? status.job : null

      // The dev server is one of the things being restarted, so it can't answer for a moment
      if (!current) {
        setPhase('restarting')
        return
      }

      setJob(current)
      if (current.status === 'failed')
        setError(current.error ?? 'The install failed')
      setPhase(current.status)
    }, INSTALL_POLL_MS)

    return () => clearInterval(timer)
  }, [job, phase, fetchFn])

  const install = async () => {
    setPhase('starting')
    try {
      setJob(await startInstall(request.packages, fetchFn))
      setPhase('installing')
    }
    catch (err) {
      setError((err as Error).message)
      setPhase('failed')
    }
  }

  return (
    <div className={styles.backdrop}>
      <div className={styles.dialog} role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <h2 id={titleId} className={styles.title}>
          {phase === 'confirm' && `Install ${names}?`}
          {phase === 'starting' && `Installing ${names}`}
          {phase === 'installing' && `Installing ${names}`}
          {phase === 'restarting' && `Installed ${names}, restarting`}
          {phase === 'done' && `Installed ${names}`}
          {phase === 'failed' && `Could not install ${names}`}
        </h2>

        {phase === 'confirm' && (
          <>
            <p className={styles.warning}>Installing a package runs its code on this machine.</p>
            <p>
              Its install scripts run right away, and a plugin runs inside your game and your game server from
              then on, with everything they can reach. Nothing reviews what is installed from here, and being
              on the list of plugins is not a review either.
            </p>
            <p>Check the source before you install it:</p>
            <ul className={styles.sources}>
              {request.packages.map((spec) => {
                const source = sourceOf(spec, request.packages.length === 1 ? request.homepage : undefined)
                return (
                  <li key={spec}>
                    <code>{spec}</code>
                    {source
                      ? <a href={source} target="_blank" rel="noreferrer">{source}</a>
                      : <span className={styles.muted}>No page to link to: look at what it points to yourself</span>}
                  </li>
                )
              })}
            </ul>
            <p className={styles.muted}>
              It is installed with the project&apos;s package manager and added to mavonengine.json when it is a
              plugin. Then the dev servers are restarted and the editor reloads.
            </p>
            <label className={styles.check}>
              <input type="checkbox" checked={checked} onChange={event => setChecked(event.target.checked)} />
              I have checked the source and trust it
            </label>
          </>
        )}

        {running && (
          <p className={styles.muted} role="status">
            {phase === 'restarting'
              ? 'The dev servers are restarting. The editor reloads when they are back.'
              : 'Running the package manager…'}
          </p>
        )}

        {phase === 'done' && <p role="status">The dev servers were restarted with it. Reload the editor to use it.</p>}

        {phase === 'failed' && <p className={styles.error} role="alert">{error}</p>}

        {job?.output && <pre className={styles.output}>{job.output}</pre>}

        <div className={styles.buttons}>
          {phase === 'confirm' && (
            <>
              <button className={styles.button} onClick={onClose}>Cancel</button>
              <button className={`${styles.button} ${styles.primary}`} disabled={!checked} onClick={() => void install()}>Install</button>
            </>
          )}
          {phase === 'done' && <button className={`${styles.button} ${styles.primary}`} onClick={() => window.location.reload()}>Reload the editor</button>}
          {(phase === 'done' || phase === 'failed') && <button className={styles.button} onClick={onClose}>Close</button>}
        </div>
      </div>
    </div>
  )
}
