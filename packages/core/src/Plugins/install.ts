/**
 * Installing packages from the editor or the dashboard while `mavonengine dev` runs.
 *
 * The browser can't run a package manager, so the editor asks the Vite dev server (`PLUGIN_INSTALL_PATH`),
 * which passes the request on to the `mavonengine dev` process that started it. That process installs the
 * packages, adds the plugins among them to mavonengine.json and restarts the dev script.
 *
 * Runs in Node and in the browser: only names, types and the check of what may be installed live here.
 */

/** Dev only: GET says whether packages can be installed and how the last install went, POST { packages } starts one */
export const PLUGIN_INSTALL_PATH = '/__mavonengine/plugin-install'

/** Set by `mavonengine dev` for the dev script: where its control server listens, on localhost */
export const DEV_CONTROL_URL_ENV = 'MAVONENGINE_DEV_CONTROL_URL'
/** Set by `mavonengine dev` for the dev script: the secret its control server asks for */
export const DEV_CONTROL_TOKEN_ENV = 'MAVONENGINE_DEV_CONTROL_TOKEN'
export const DEV_CONTROL_TOKEN_HEADER = 'x-mavonengine-dev-token'

export const MAX_INSTALL_PACKAGES = 10
const MAX_SPEC_LENGTH = 300

/**
 * What a package to install may look like: a name, `name@1.2.3`, a `file:` path or a git / https URL.
 * Nothing a shell reads as more than a word, and nothing the package manager reads as an option:
 * on Windows the package manager is started through a shell.
 */
const PACKAGE_SPEC_RE = /^[\w@./~][\w@./:~=+#-]*$/

/**
 * Why `packages` can't be installed, undefined when they can
 */
export function invalidPackages(packages: unknown): string | undefined {
  if (!Array.isArray(packages) || packages.length === 0)
    return 'Expected { packages: [...] } with at least one package'
  if (packages.length > MAX_INSTALL_PACKAGES)
    return `At most ${MAX_INSTALL_PACKAGES} packages at a time`

  for (const spec of packages) {
    if (typeof spec !== 'string' || spec.length > MAX_SPEC_LENGTH || !PACKAGE_SPEC_RE.test(spec))
      return `${JSON.stringify(spec)} is not something that can be installed from here: use a package name, name@version, a file: path or a URL, without spaces or version ranges like ^1.0.0`
  }

  return undefined
}

export interface InstallJob {
  /** Goes up with every install of this `mavonengine dev` run */
  id: number
  packages: string[]
  /**
   * `installing` while the package manager runs, `restarting` while the dev script is stopped and started again,
   * then `done`. `failed` when the install didn't work: nothing is restarted then.
   */
  status: 'installing' | 'restarting' | 'done' | 'failed'
  /** What the package manager and `mavonengine install` wrote so far, the end of it when it is long */
  output: string
  /** Why it failed */
  error?: string
}

export interface InstallStatus {
  /** Whether packages can be installed from here: the project runs under `mavonengine dev` */
  available: boolean
  /** Why not, when they can't */
  reason?: string
  /** The running or last install, null when there was none */
  job: InstallJob | null
}
