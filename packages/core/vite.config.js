import { readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import glsl from 'vite-plugin-glsl'
import { createPackageJsonPlugin } from './vite/plugins/packageJsonPlugin.js'

const GLSL_FILTER = /\.glsl$/

const coreRoot = dirname(fileURLToPath(import.meta.url))

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
        createPackageJsonPlugin(coreRoot),
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
