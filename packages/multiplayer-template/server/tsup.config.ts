import type { Plugin } from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'tsup'

const packageJsonPlugin: Plugin = {
  name: 'package-json',
  setup(build) {
    build.onResolve({ filter: /[/\\]package\.json$/ }, args => ({
      path: path.resolve(args.resolveDir, args.path),
      namespace: 'pkg-json',
    }))
    build.onLoad({ filter: /.*/, namespace: 'pkg-json' }, (args) => {
      const pkg = JSON.parse(fs.readFileSync(args.path, 'utf8'))
      const named = Object.entries(pkg)
        .filter(([k]) => /^[a-z_$][\w$]*$/i.test(k))
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
