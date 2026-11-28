import { defineConfig } from 'tsup'

// Declarations come from tsc: tsup's dts build sets baseUrl, which TypeScript 7 rejects
export default defineConfig([
  {
    // Bundled into the game by Vite
    entry: ['src/client.ts', 'src/shared.ts'],
    format: ['esm'],
    target: 'es2022',
    dts: false,
    clean: true,
  },
  {
    // Runs in the client's Vite dev server, in Node
    entry: { dev: 'src/dev.ts' },
    format: ['esm'],
    platform: 'node',
    target: 'node24',
    dts: false,
    removeNodeProtocol: false,
  },
])
