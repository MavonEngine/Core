import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  dts: false,
  clean: true,
  target: 'node24',
  banner: {
    js: '#!/usr/bin/env node',
  },
})
