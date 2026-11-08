import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  // Declarations come from tsc: tsup's dts build sets baseUrl, which TypeScript 7 rejects
  dts: false,
  clean: true,
  // The browser page in ui/ is served as is, from next to dist/
})
