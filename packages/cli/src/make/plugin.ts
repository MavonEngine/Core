import type { PluginTarget } from '@mavonengine/core/Plugins/types'
import type { PackageManager } from '../commands/dev'
import type { ScaffoldFiles } from './scaffold'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { runsOn } from '@mavonengine/core/Plugins/ProjectConfig'
import { kebabName, titleName } from './scaffold'

/** Where `make:plugin` puts plugins, relative to the project root */
export const PLUGINS_DIR = 'plugins'

/** The workspace glob that covers every plugin made with `make:plugin` */
export const PLUGINS_WORKSPACE = `${PLUGINS_DIR}/*`

const INDENT_RE = /^[ \t]+/m

export interface PluginScaffoldOptions {
  /** npm package name, the key in mavonengine.json */
  name: string
  target: PluginTarget
  /** Supported @mavonengine/core range, left out when undefined */
  engine?: string
}

/** The plugin's directory, relative to the project root: `plugins/<name without scope>` */
export function pluginDirFor(name: string): string {
  return `${PLUGINS_DIR}/${kebabName(name)}`
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

/**
 * The files of a new plugin. Its entries are TypeScript sources: Vite compiles the client one and Node 24 strips
 * the types of the server one, so a plugin inside the project runs without a build step.
 */
export function pluginFiles({ name, target, engine }: PluginScaffoldOptions): ScaffoldFiles {
  const title = titleName(name) || name
  const slug = kebabName(name) || 'plugin'
  const client = runsOn(target, 'client')
  const server = runsOn(target, 'server')

  const files: ScaffoldFiles = {}

  files['package.json'] = json({
    name,
    type: 'module',
    version: '0.1.0',
    private: true,
    description: `${title}: a MavonEngine plugin`,
    scripts: {
      typecheck: 'tsc -p tsconfig.json',
    },
    ...(engine
      ? {
          peerDependencies: { '@mavonengine/core': engine },
        }
      : {}),
    mavonengine: {
      target,
      ...(client
        ? { client: './src/client.ts' }
        : {}),
      ...(server
        ? { server: './src/server.ts' }
        : {}),
      ...(engine
        ? { engine }
        : {}),
    },
  })

  files['tsconfig.json'] = json({
    compilerOptions: {
      target: 'es2022',
      lib: client
        ? ['es2022', 'dom']
        : ['es2022'],
      module: 'nodenext',
      moduleResolution: 'nodenext',
      strict: true,
      noEmit: true,
      skipLibCheck: true,
      // The server entry runs through Node's type stripping, which only takes erasable syntax and .ts imports
      allowImportingTsExtensions: true,
      erasableSyntaxOnly: true,
      verbatimModuleSyntax: true,
    },
    include: ['src'],
  })

  if (client) {
    files['src/client.ts'] = `import { defineClientPlugin } from '@mavonengine/core/Plugins/types'

export default defineClientPlugin({
  name: ${JSON.stringify(title)},

  // Files the game loads with the plugin, from its assets/ directory:
  // assets: ctx => [{ name: 'tree', type: 'gltfModel', path: ctx.assetUrl('models/tree.glb') }],

  setup(ctx) {
    ctx.logger?.info(\`\${ctx.package} loaded on the client\`)
  },

  update(_delta, _ctx) {},
})
`
  }

  if (server) {
    files['src/server.ts'] = `import { defineServerPlugin } from '@mavonengine/core/Plugins/types'

export default defineServerPlugin({
  name: ${JSON.stringify(title)},

  setup(ctx) {
    ctx.logger?.info(\`\${ctx.package} loaded on the server\`)
  },

  http(app, _ctx) {
    app.get('/api/${slug}/status', (_req, res) => res.json({ ok: true }))
  },

  onConnection(_channel, _client, _ctx) {},

  tick(_delta, _ctx) {},
})
`
  }

  const sides = [client && '`src/client.ts` runs in the game', server && '`src/server.ts` runs on the game server'].filter(Boolean)
  files['README.md'] = `# ${title}

A MavonEngine plugin, made with \`mavonengine make:plugin\`. ${sides.join(' and ')}.

It is a workspace of the project and registered in \`mavonengine.json\`, so \`mavonengine dev\` loads it.
${client ? 'The game reloads when the client entry changes. ' : ''}${server ? 'Restart the game server to pick up changes to the server entry.' : ''}

- Options: \`plugins["${name}"].options\` in \`mavonengine.json\`, as \`ctx.options\`.
- Assets: put them in \`assets/\` and list them under \`mavonengine.assets\` in \`package.json\`.
- Types: \`npm run typecheck\` in this directory.

See [Writing a plugin](https://github.com/MavonEngine/Core/tree/main/packages/cli#writing-a-plugin) for every hook.
`

  return files
}

/**
 * Make the package manager link `plugins/*` into node_modules, so the plugin resolves like an installed one.
 * npm, yarn and bun read `workspaces` in package.json; pnpm gets a `link:` dependency instead, as it only reads
 * workspaces from pnpm-workspace.yaml. Returns what was changed, or undefined when nothing needed to be.
 */
export function linkPlugin(root: string, pm: PackageManager, name: string, dir: string): string | undefined {
  const path = join(root, 'package.json')
  const text = readFileSync(path, 'utf8')
  const pkg = JSON.parse(text)
  const indent = INDENT_RE.exec(text)?.[0] ?? '  '

  let change: string | undefined
  if (pm === 'pnpm' || existsSync(join(root, 'pnpm-workspace.yaml'))) {
    const spec = `link:./${dir}`
    if (pkg.dependencies?.[name] === spec)
      return undefined
    pkg.dependencies = { ...pkg.dependencies, [name]: spec }
    change = `added "${name}": "${spec}" to dependencies`
  }
  else {
    // `workspaces` is a list, or yarn's { packages: [...] }
    const list: unknown = Array.isArray(pkg.workspaces)
      ? pkg.workspaces
      : pkg.workspaces?.packages
    const globs = Array.isArray(list)
      ? list.map(String)
      : []
    if (globs.includes(PLUGINS_WORKSPACE) || globs.includes(dir) || globs.includes(`./${dir}`))
      return undefined

    if (pkg.workspaces && !Array.isArray(pkg.workspaces) && typeof pkg.workspaces === 'object')
      pkg.workspaces.packages = [...globs, PLUGINS_WORKSPACE]
    else
      pkg.workspaces = [...globs, PLUGINS_WORKSPACE]
    change = `added "${PLUGINS_WORKSPACE}" to workspaces`
  }

  writeFileSync(path, `${JSON.stringify(pkg, null, indent)}\n`)
  return change
}
