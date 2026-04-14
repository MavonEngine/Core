import { defineConfig } from 'tsup'

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
})
