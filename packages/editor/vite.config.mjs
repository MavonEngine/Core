import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { glob } from 'glob'
import { defineConfig } from 'vite'
import glsl from 'vite-plugin-glsl'

const EXTENDS_RE = /\bclass\s+\w+\s+extends\s+(?:ParticleEffect|Emitter)\b/
const ASSETS_RE = /Assets\.tsx$/
const TS_EXT_RE = /\.ts$/
// Peer dependencies the game provides. A copy of one in the bundle means an `external` entry misses it
const PEER_IN_BUNDLE_RE = /[\\/]node_modules[\\/](?:react|react-dom|three|@mavonengine[\\/]core)[\\/]/
// Rolldown's error for a CommonJS require() of an external it couldn't turn into an import.
// Browsers have no require, so the chunk throws when it loads
const REQUIRE_SHIM = 'in an environment that doesn\'t expose the `require` function'

const editorRoot = dirname(fileURLToPath(import.meta.url))
const coreRoot = resolve(editorRoot, '../core')

async function findParticleFiles(projectRoot) {
  const searchRoots = [coreRoot]
  if (projectRoot !== editorRoot)
    searchRoots.push(projectRoot)

  const results = await Promise.all(
    searchRoots.map(cwd => glob('**/*.ts', { cwd, ignore: ['**/node_modules/**', '**/*.d.ts'], absolute: true })),
  )
  const files = [...new Set(results.flat())]

  return files.filter((f) => {
    try {
      return EXTENDS_RE.test(readFileSync(f, 'utf8'))
    }
    catch {
      return false
    }
  })
}

export default defineConfig(({ command }) => ({
  resolve: {
    alias: command === 'serve'
      ? { '@mavonengine/core': resolve(coreRoot, 'src') }
      : {},
  },
  plugins: [
    (() => {
      let projectRoot = editorRoot
      return {
        name: 'auto-particle-effects',
        configResolved(config) {
          projectRoot = config.root
        },
        async transform(code, id) {
          if (!ASSETS_RE.test(id))
            return null
          const files = await findParticleFiles(projectRoot)
          const coreSrc = `${coreRoot.replaceAll('\\', '/')}/src/`
          const injected = files.map((f) => {
            const normalized = f.replaceAll('\\', '/')
            if (normalized.startsWith(coreSrc)) {
              const relative = normalized.slice(coreSrc.length).replace(TS_EXT_RE, '')
              return `import '@mavonengine/core/${relative}'`
            }
            return `import '${normalized}'`
          }).join('\n')
          return `${injected}\n${code}`
        },
        configureServer(server) {
          server.watcher.on('add', async (path) => {
            try {
              if (!EXTENDS_RE.test(readFileSync(path, 'utf8')))
                return
            }
            catch { return }
            const mod = [...server.moduleGraph.fileToModulesMap.values()]
              .flat()
              .find(m => ASSETS_RE.test(m.id ?? ''))
            if (mod)
              server.moduleGraph.invalidateModule(mod)
          })
        },
      }
    })(),
    glsl(),
    react(),
  ],
  build: {
    lib: {
      entry: resolve(editorRoot, 'src/Editor.ts'),
      name: 'MavonEditor',
      fileName: 'Editor',
      formats: ['es'],
    },
    rolldownOptions: {
      external: id => ['react', 'react-dom', 'react/jsx-runtime', 'three'].includes(id) || id.startsWith('react/') || id.startsWith('react-dom/') || id.startsWith('three/') || id.startsWith('@mavonengine/core') || id.startsWith(coreRoot),
      plugins: [
        {
          name: 'inject-css-into-mount-chunk',
          generateBundle(_, bundle) {
            const cssFile = Object.keys(bundle).find(k => k.endsWith('.css'))
            // Inject into the dynamic mount chunk so CSS only loads when new Editor() is called
            const mountChunk = Object.values(bundle).find(chunk => chunk.type === 'chunk' && chunk.isDynamicEntry)
            if (cssFile && mountChunk)
              mountChunk.code = `import './${cssFile}';\n${mountChunk.code}`
          },
        },
        {
          // Source builds alias the editor to src/, so a bundle that only breaks in the browser goes unnoticed there
          name: 'check-bundle-for-browser',
          generateBundle(_, bundle) {
            const problems = []
            for (const chunk of Object.values(bundle)) {
              if (chunk.type !== 'chunk')
                continue
              for (const id of chunk.moduleIds.filter(id => PEER_IN_BUNDLE_RE.test(id)))
                problems.push(`${chunk.fileName} bundles ${id}, it should be external`)
              if (chunk.code.includes(REQUIRE_SHIM))
                problems.push(`${chunk.fileName} calls require() at runtime, which fails in the browser`)
            }
            if (problems.length)
              this.error(`The editor bundle would break in projects that install it:\n  ${problems.join('\n  ')}\nCheck build.rolldownOptions.external`)
          },
        },
      ],
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      include: ['src'],
      reportOnFailure: true,
    },
  },
}))
