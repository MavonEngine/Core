import { defineConfig } from 'tsup'

export default defineConfig({
  // The dev entry runs in the client's Vite dev server, for the tools AI assistants get through `mavonengine mcp`
  entry: { index: 'src/index.ts', dev: 'src/dev.ts' },
  format: ['esm'],
  platform: 'node',
  target: 'node24',
  // Declarations come from tsc: tsup's dts build sets baseUrl, which TypeScript 7 rejects
  dts: false,
  clean: true,
  removeNodeProtocol: false,
})
