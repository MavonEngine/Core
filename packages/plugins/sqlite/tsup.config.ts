import { defineConfig } from 'tsup'

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  // Declarations come from tsc: tsup's dts build sets baseUrl, which TypeScript 7 rejects
  dts: false,
  clean: true,
  // node:sqlite has no name without the prefix, which tsup drops by default
  removeNodeProtocol: false,
})
