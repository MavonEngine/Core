import { existsSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import glsl from 'vite-plugin-glsl'

const GLSL_FILTER = /\.glsl$/

const ENGINE_PLUGINS_VITE = new URL('./dist/Plugins/vite.js', import.meta.url)

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
    // Engine plugins from mavonengine.json: `virtual:mavonengine/plugins`, their assets in dev and the release.
    // Compiled from src/Plugins/vite.ts; missing only before core's own first build, e.g. for its tests
    existsSync(fileURLToPath(ENGINE_PLUGINS_VITE)) && import(ENGINE_PLUGINS_VITE.href).then(({ mavonEnginePlugins }) => mavonEnginePlugins()),
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
