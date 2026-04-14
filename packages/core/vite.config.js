import { readFileSync } from 'node:fs'
import { defineConfig } from 'vite'
import glsl from 'vite-plugin-glsl'

const GLSL_FILTER = /\.glsl$/

const mavonEngineGlslPlugin = {
  name: 'glsl',
  setup(build) {
    build.onLoad({ filter: GLSL_FILTER }, (args) => {
      return {
        contents: `export default ${JSON.stringify(readFileSync(args.path, 'utf8'))}`,
        loader: 'js',
      }
    })
  },
}

export default defineConfig({
  plugins: [
    glsl(),
  ],
  optimizeDeps: {
    esbuildOptions: {
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
