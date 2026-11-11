import { defineConfig } from 'tsup'

export default defineConfig({
  // The server entry runs in Node, the client entry is bundled into the game by Vite. Neither imports
  // anything at runtime but the protocol they share, so one build serves both
  entry: ['src/client.ts', 'src/server.ts', 'src/protocol.ts'],
  format: ['esm'],
  target: 'es2022',
  // Declarations come from tsc: tsup's dts build sets baseUrl, which TypeScript 7 rejects
  dts: false,
  clean: true,
})
