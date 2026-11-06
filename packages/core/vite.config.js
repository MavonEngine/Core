import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import glsl from 'vite-plugin-glsl'

const GLSL_FILTER = /\.glsl$/

const mavonEngineGlslPlugin = {
  name: 'glsl',
  load(id) {
    if (!GLSL_FILTER.test(id))
      return null
    return {
      code: `export default ${JSON.stringify(readFileSync(id, 'utf8'))}`,
      moduleType: 'js',
    }
  },
}

export default defineConfig({
  plugins: [
    glsl(),
  ],
  optimizeDeps: {
    rolldownOptions: {
      plugins: [
        mavonEngineGlslPlugin,
      ],
    },
  },
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
