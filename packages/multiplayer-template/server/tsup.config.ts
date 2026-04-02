import type { Plugin } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'tsup'

const PACKAGE_JSON_FILTER = /[/\\]package\.json$/
const ALL_FILTER = /.*/
const IDENTIFIER_FILTER = /^[a-z_$][\w$]*$/i

const packageJsonPlugin: Plugin = {
  name: 'package-json',
  setup(build) {
    build.onResolve({ filter: PACKAGE_JSON_FILTER }, args => ({
      path: path.resolve(args.resolveDir, args.path),
      namespace: 'pkg-json',
    }))
    build.onLoad({ filter: ALL_FILTER, namespace: 'pkg-json' }, (args) => {
      const pkg = JSON.parse(fs.readFileSync(args.path, 'utf8'))
      const named = Object.entries(pkg)
        .filter(([k]) => IDENTIFIER_FILTER.test(k))
        .map(([k, v]) => `export const ${k} = ${JSON.stringify(v)};`)
        .join('\n')
      return { contents: `${named}\nexport default ${JSON.stringify(pkg)};`, loader: 'js' }
    })
  },
}

export default defineConfig({
  entry: ['src/index.ts'],
  platform: 'node',
  format: ['esm'],
  outDir: 'dist',
  bundle: true,
  splitting: false,
  sourcemap: true,
  noExternal: ['@mavonengine/core'],
  external: [
    '@geckos.io/server',
    'express',
    'winston',
    'three',
  ],
  esbuildPlugins: [packageJsonPlugin],
})
