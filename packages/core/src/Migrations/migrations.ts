import type { ProjectFiles } from './ProjectFiles.js'

/**
 * Changes to a project that a new @mavonengine/core needs or makes possible, applied by `mavonengine upgrade`.
 *
 * A migration only changes files through `files`, so the change can be shown first, and must leave a project it
 * already ran on alone (`applies` is false afterwards). Ids are `<since>-<name>` and never change once released:
 * a project's mavonengine.json records the ones it has had.
 */
export interface MigrationContext {
  files: ProjectFiles
  versions: {
    /** The project's @mavonengine/core */
    core: string
    /** The @mavonengine/cli running the migration */
    cli?: string
  }
}

export interface Migration {
  id: string
  /** The first @mavonengine/core version the migrated project needs */
  since: string
  /** One line: what it changes */
  description: string
  applies(ctx: MigrationContext): boolean
  run(ctx: MigrationContext): void
}

const CONFIG = 'mavonengine.json'
const RUNS_MAVONENGINE_DEV_RE = /\bmavonengine\s+dev\b/
const TITLE_RE = /(<title[^>]*>)([\s\S]*?)(<\/title>)/i
const ENTITY_RE = /&(amp|lt|gt|quot|#39|apos);/g
const ENTITIES: Record<string, string> = {
  'amp': '&',
  'lt': '<',
  'gt': '>',
  'quot': '"',
  '#39': '\'',
  'apos': '\'',
}
const APP_NAME_PLACEHOLDER = '%MAVONENGINE_APP_NAME%'
const INDEX_HTML = ['client/index.html', 'index.html']

/**
 * `npm run dev` starts `mavonengine dev`, which runs the old dev script as `dev:server` and shows the dashboard.
 * Projects from before core 0.0.22 ran the game server straight from `dev`.
 */
const devScript: Migration = {
  id: '0.0.22-dev-script',
  since: '0.0.22',
  description: '`npm run dev` starts `mavonengine dev`, the old dev script becomes `dev:server`',

  applies({ files }) {
    const scripts = files.readJson('package.json')?.scripts
    return typeof scripts?.dev === 'string' && scripts['dev:server'] === undefined && !RUNS_MAVONENGINE_DEV_RE.test(scripts.dev)
  },

  run({ files, versions }) {
    const pkg = files.readJson('package.json')!
    // dev:server right after dev, the rest in their order
    pkg.scripts = Object.fromEntries(Object.entries(pkg.scripts as Record<string, string>).flatMap(([name, script]) =>
      name === 'dev'
        ? [
            ['dev', 'mavonengine dev'],
            ['dev:server', script],
          ]
        : [
            [name, script],
          ]))

    if (!pkg.dependencies?.['@mavonengine/cli'] && !pkg.devDependencies?.['@mavonengine/cli']) {
      const devDependencies = { ...pkg.devDependencies, '@mavonengine/cli': versions.cli ?? 'latest' }
      pkg.devDependencies = Object.fromEntries(Object.entries(devDependencies).sort(([a], [b]) => a.localeCompare(b)))
    }

    files.writeJson('package.json', pkg)
  },
}

function titleFiles(files: ProjectFiles): { path: string, html: string, title: string }[] {
  return INDEX_HTML.flatMap((path) => {
    const html = files.read(path)
    const match = html === undefined
      ? undefined
      : TITLE_RE.exec(html)
    return match && !match[2].includes(APP_NAME_PLACEHOLDER)
      ? [
          { path, html: html!, title: match[2] },
        ]
      : []
  })
}

/**
 * The browser tab shows `appName` from mavonengine.json: index.html's title becomes the placeholder core 0.0.25
 * fills in, and the title it had becomes the appName, so the tab says the same as before.
 */
const appNameTitle: Migration = {
  id: '0.0.25-app-name-title',
  since: '0.0.25',
  description: `index.html's title becomes ${APP_NAME_PLACEHOLDER}, the title it had becomes appName in ${CONFIG}`,

  applies: ({ files }) => titleFiles(files).length > 0,

  run({ files }) {
    const found = titleFiles(files)
    for (const { path, html } of found)
      files.write(path, html.replace(TITLE_RE, `$1${APP_NAME_PLACEHOLDER}$3`))

    const config = files.readJson(CONFIG) ?? { plugins: {} }
    const title = found[0].title.replace(ENTITY_RE, (_, entity: string) => ENTITIES[entity]).trim()
    if (config.appName === undefined && title) {
      config.appName = title
      files.writeJson(CONFIG, config)
    }
  },
}

/** Every migration, oldest first */
export const MIGRATIONS: Migration[] = [devScript, appNameTitle]
