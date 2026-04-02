import { existsSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import config from '@mavonengine/core/vite.config'
import vue from '@vitejs/plugin-vue'

const GLSL_FILTER = /\.glsl$/
const PACKAGE_JSON_FILTER = /[/\\]package\.json$/
const ALL_FILTER = /.*/
const IDENTIFIER_FILTER = /^[a-z_$][\w$]*$/i

const clientRoot = dirname(fileURLToPath(import.meta.url))
const templateRoot = resolve(clientRoot, '..')
const coreRoot = resolve(clientRoot, '../../core')
const coreSrc = resolve(coreRoot, 'src')
const editorRoot = resolve(clientRoot, '../../editor')
const editorSrc = resolve(editorRoot, 'src/Editor.ts')

// esbuild plugin: handles .glsl imports during dep pre-bundling
const glslPlugin = {
  name: 'glsl',
  setup(build) {
    build.onLoad({ filter: GLSL_FILTER }, (args) => {
      return { contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))}`, loader: 'js' }
    })
  },
}

// esbuild plugin: handles `import { version } from 'package.json' with { type: 'json' }`
// esbuild rejects this because @mavonengine/core's exports field doesn't list package.json
const packageJsonPlugin = {
  name: 'package-json',
  setup(build) {
    build.onResolve({ filter: PACKAGE_JSON_FILTER }, args => ({ path: args.path, namespace: 'pkg-json' }))
    build.onLoad({ filter: ALL_FILTER, namespace: 'pkg-json' }, (args) => {
      const pkg = JSON.parse(readFileSync(args.path, 'utf8'))
      const named = Object.entries(pkg)
        .filter(([k]) => IDENTIFIER_FILTER.test(k))
        .map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`)
        .join('\n')
      return { contents: `${named}\nexport default ${JSON.stringify(pkg)};`, loader: 'js' }
    })
  },
}

export default {
  ...config,
  optimizeDeps: {
    esbuildOptions: {
      plugins: [glslPlugin, packageJsonPlugin],
    },
  },
  server: {
    ...config.server,
    fs: {
      allow: [templateRoot, resolve(clientRoot, '../../')],
    },
  },
  plugins: [
    ...config.plugins,
    vue(),
  ],
  resolve: {
    ...config.resolve,
    alias: {
      ...(existsSync(editorSrc) ? { '@mavonengine/editor': editorSrc } : {}),
      ...(existsSync(coreSrc) ? { '@mavonengine/core': coreSrc } : {}),
      '@template/server': resolve(templateRoot, 'server/src'),
    },
    dedupe: ['@mavonengine/core', 'three', 'vue', 'react', 'react-dom', '@dimforge/rapier3d-compat'],
  },
}
