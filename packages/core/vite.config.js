import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import glsl from 'vite-plugin-glsl'

const GLSL_FILTER = /\.glsl$/
const PACKAGE_JSON_FILTER = /[/\\]package\.json$/
const ALL_FILTER = /.*/
const IDENTIFIER_FILTER = /^[a-z_$][\w$]*$/i

const coreRoot = dirname(fileURLToPath(import.meta.url))

const mavonEngineGlslPlugin = {
  name: 'glsl',
  setup(build) {
    build.onLoad({ filter: GLSL_FILTER }, (args) => {
      return {
        contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))}`,
        loader: 'js',
      }
    })
  },
}

/*
 * Allows importing package.json as an ES module with named exports so the
 * client package can display the correct engine version at runtime.
 */
const mavonEnginePackageJsonPlugin = {
  name: 'package-json',
  setup(build) {
    build.onResolve({ filter: PACKAGE_JSON_FILTER }, (args) => {
      const path = args.path.includes('@mavonengine/core')
        ? resolve(coreRoot, 'package.json')
        : args.path
      return { path, namespace: 'mavonengine-pkg-json' }
    })
    build.onLoad({ filter: ALL_FILTER, namespace: 'mavonengine-pkg-json' }, (args) => {
      const pkg = JSON.parse(readFileSync(args.path, 'utf8'))
      const named = Object.entries(pkg)
        .filter(([k]) => IDENTIFIER_FILTER.test(k))
        .map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`)
        .join('\n')
      return { contents: `${named}\nexport default ${JSON.stringify(pkg)};`, loader: 'js' }
    })
  },
}

export default defineConfig({
  plugins: [
    glsl(),
  ],
  optimizeDeps: {
    esbuildOptions: {
      plugins: [
        mavonEngineGlslPlugin,
        mavonEnginePackageJsonPlugin,
      ],
    },
  },
  server: {
    watch: {
      // For local npm link dev mode in @mavonengine/core
      followSymlinks: true,
    },
  },
  test: {
    coverage: {
      provider: 'v8',
      include: ['src'],
      reportOnFailure: true,
    },
  },
})
