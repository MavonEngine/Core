import { defineConfig } from 'vite'
import glsl from 'vite-plugin-glsl'

export default defineConfig({
  plugins: [
    glsl(),
  ],
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
